// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { Opcode } from "@1inch/swap-vm/src/libs/OpcodeList.sol";

import { BebecitaRouter } from "../src/routers/BebecitaRouter.sol";
import { BebecitaVault } from "../src/vault/BebecitaVault.sol";
import { UnwindPricedBalancesArgsBuilder } from "../src/instructions/UnwindPricedBalances.sol";
import { IHookStats, PoolKey } from "../src/interfaces/IHookStats.sol";
import { TestERC20 } from "../src/mocks/TestERC20.sol";
import { MockPositionManager } from "../src/mocks/MockPositionManager.sol";

/// @title BebecitaTest
/// @notice The behaviour of a maker whose inventory lives outside its wallet.
contract BebecitaTest is Test {
    uint256 internal constant TOKEN_ID = 1;
    uint256 internal constant POSITION_LIQUIDITY = 1_000 ether;
    uint256 internal constant SHIPPED_BALANCE = 10_000 ether;
    uint8 internal constant MAX_UNWIND_PCT = 50;
    uint16 internal constant HAIRCUT_BPS = 500;
    uint128 internal constant UNITS_PER_LIQUIDITY = 1e18;

    Aqua internal aqua;
    BebecitaRouter internal router;
    BebecitaVault internal vault;
    MockPositionManager internal posm;
    TestERC20 internal token0;
    TestERC20 internal token1;

    address internal taker = address(uint160(0x7A4E));

    function setUp() public {
        aqua = new Aqua();

        TestERC20 a = new TestERC20("Alpha", "ALPHA", 18);
        TestERC20 b = new TestERC20("Bravo", "BRAVO", 18);
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);

        posm = new MockPositionManager(address(token0), address(token1), UNITS_PER_LIQUIDITY);
        router = new BebecitaRouter(address(aqua), address(0), address(this), "Bebecita", "1");
        vault = new BebecitaVault(
            IAqua(address(aqua)),
            address(router),
            address(posm),
            TOKEN_ID,
            address(this),
            MAX_UNWIND_PCT,
            HAIRCUT_BPS,
            UNITS_PER_LIQUIDITY
        );

        // The position holds the inventory. The position manager holds the tokens behind it.
        posm.seed(TOKEN_ID, POSITION_LIQUIDITY);
        token0.mint(address(posm), POSITION_LIQUIDITY);
        token1.mint(address(posm), POSITION_LIQUIDITY);

        // The vault approves Aqua so pull() can move tokens out, and the manager so redeposits work.
        vault.approveAqua(address(token0), type(uint256).max);
        vault.approveAqua(address(token1), type(uint256).max);
        vault.approvePositionManager(address(token0), type(uint256).max);
        vault.approvePositionManager(address(token1), type(uint256).max);

        // The taker funds itself and lets the router pull the input side.
        token0.mint(taker, 1_000 ether);
        vm.prank(taker);
        token0.approve(address(router), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // The slot claim, machine checked
    // ---------------------------------------------------------------------

    /// @notice The instruction occupies the reserved slot of the correct family bank.
    /// @dev `OpcodeList.sol` states: "New instruction MUST take the next free `_Ix` slot of its family bank."
    ///      Our instruction adjusts a balance register, so it belongs to 0x90-0xaf, whose next free slot is
    ///      `_92`. Asserting it here means the README does not have to be believed.
    function test_InstructionTakesReservedSlotOfBalancesTuningBank() public view {
        assertEq(uint256(Opcode._92), router.OPCODE_UNWIND_PRICED_BALANCE_OUT(), "wrong reserved slot");
        assertEq(uint256(Opcode.StaticBalances), 0x90, "bank moved");
        assertEq(uint256(Opcode.DynamicBalances), 0x91, "bank moved");
    }

    // ---------------------------------------------------------------------
    // The negative moment, as a test
    // ---------------------------------------------------------------------

    /// @notice Without the instruction, Aqua quotes depth the maker cannot deliver and the swap dies at the end.
    /// @dev This is the failure the whole project exists to close, and it is worth having as an executable
    ///      assertion rather than a slide: the quote succeeds, and the swap reverts inside `Aqua.pull` on the
    ///      `safeTransferFrom` out of an empty wallet.
    function test_WithoutInstruction_QuotePassesAndSwapReverts() public {
        ISwapVM.Order memory order = _buildOrder(false);
        _ship(order);

        bytes memory takerData = _buildTakerData(new bytes(0), new bytes(0));

        (, uint256 quotedOut,) = ISwapVM(address(router)).quote(order, 100 ether, takerData);
        assertGt(quotedOut, 0, "quote should succeed against the shipped virtual balance");

        vm.prank(taker);
        vm.expectRevert();
        ISwapVM(address(router)).swap(order, 100 ether, takerData);
    }

    // ---------------------------------------------------------------------
    // The instruction
    // ---------------------------------------------------------------------

    /// @notice With the instruction, the quote is clamped to what the position can actually release.
    function test_WithInstruction_QuoteIsClampedToReachableCollateral() public {
        ISwapVM.Order memory withInstruction = _buildOrder(true);
        ISwapVM.Order memory withoutInstruction = _buildOrder(false);
        _ship(withInstruction);
        _ship(withoutInstruction);

        bytes memory takerData = _buildTakerData(new bytes(0), new bytes(0));

        (, uint256 naiveOut,) = ISwapVM(address(router)).quote(withoutInstruction, 100 ether, takerData);
        (, uint256 clampedOut,) = ISwapVM(address(router)).quote(withInstruction, 100 ether, takerData);

        assertLt(clampedOut, naiveOut, "the instruction must lower the quote, never raise it");
        assertGt(clampedOut, 0, "a clamped quote is still a quote");
    }

    /// @notice The clamp equals free float plus the capped, haircut share of the position.
    function test_ReachableCollateralMatchesTheVaultAccounting() public view {
        uint256 expected = POSITION_LIQUIDITY * MAX_UNWIND_PCT / 100 * (10_000 - HAIRCUT_BPS) / 10_000;
        assertEq(vault.reachableFromPosition(), expected, "cap and haircut must compose in that order");
    }

    /// @notice Quote and swap agree, which is the only invariant of the core suite that cannot be skipped.
    /// @dev The instruction is `view`, so it satisfies this structurally rather than by discipline.
    function test_QuoteAndSwapReturnTheSameAmounts() public {
        ISwapVM.Order memory order = _buildOrder(true);
        _ship(order);

        uint256 unwind = 200 ether;
        bytes memory takerData = _buildTakerData(
            posm.encodeDecrease(TOKEN_ID, unwind, address(vault)), new bytes(0)
        );

        (uint256 quotedIn, uint256 quotedOut,) = ISwapVM(address(router)).quote(order, 50 ether, takerData);

        vm.prank(taker);
        (uint256 swappedIn, uint256 swappedOut,) = ISwapVM(address(router)).swap(order, 50 ether, takerData);

        assertEq(swappedIn, quotedIn, "amountIn diverged between quote and swap");
        assertEq(swappedOut, quotedOut, "amountOut diverged between quote and swap");
    }

    /// @notice Shipping the input side near the reachable figure is what makes the book quote a readable price.
    /// @dev `XYCSwap` is constant product, and the instruction lowers `balanceOut` only, so the quote is
    ///      roughly `balanceOut / balanceIn`. Ship both sides generously and the book quotes a fortieth of
    ///      parity, which reads as broken. Ship the input side just above what the position can release and
    ///      the price comes back, while the output side stays generous so that running without the
    ///      instruction still overstates depth on an ordinary sized fill rather than only on a huge one.
    function test_AsymmetricShipping_QuotesNearParityWhileKeepingTheOverstatement() public {
        ISwapVM.Order memory order = _buildOrder(true);

        uint256 reachable = vault.reachableFromPosition();
        uint256 inputSide = reachable * 105 / 100;
        uint256 outputSide = reachable * 40;

        address[] memory tokens = new address[](2);
        tokens[0] = address(token0);
        tokens[1] = address(token1);

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = inputSide;
        amounts[1] = outputSide;

        vault.ship(address(router), abi.encode(order), tokens, amounts);

        // Size the fill relative to the depth, the way the live book is used: a hundred tokens against
        // 23,750 reachable. A fixed size against this test's much smaller position would be a fifth of the
        // pool, and constant product slippage rather than the shipped ratio would decide the result.
        uint256 amountIn = reachable / 250;
        bytes memory takerData = _buildTakerData(new bytes(0), new bytes(0));
        (, uint256 clamped,) = ISwapVM(address(router)).quote(order, amountIn, takerData);

        // Near parity: within twenty percent of one for one, where symmetric generous shipping gave 0.025.
        assertGt(clamped, amountIn * 80 / 100, "quote collapsed, the input side is shipped too generously");
        assertLt(clamped, amountIn * 120 / 100, "quote above parity, the output side is shipped too thin");

        // And the output side is still generous enough that dropping the instruction overstates by a lot.
        ISwapVM.Order memory bare = _buildOrder(false);
        vault.ship(address(router), abi.encode(bare), tokens, amounts);
        (, uint256 unclamped,) = ISwapVM(address(router)).quote(bare, amountIn, takerData);
        assertGt(unclamped, clamped * 10, "without the instruction the quote must overstate by an order of magnitude");
    }

    // ---------------------------------------------------------------------
    // The settlement loop
    // ---------------------------------------------------------------------

    /// @notice A fill is funded by unwinding the position one instruction before the tokens leave the maker.
    function test_Fill_IsFundedByUnwindingThePosition() public {
        ISwapVM.Order memory order = _buildOrder(true);
        _ship(order);

        uint256 vaultFloatBefore = token1.balanceOf(address(vault));
        uint256 takerBefore = token1.balanceOf(taker);
        uint256 liquidityBefore = posm.liquidityOf(TOKEN_ID);

        uint256 unwind = 200 ether;
        bytes memory takerData = _buildTakerData(
            posm.encodeDecrease(TOKEN_ID, unwind, address(vault)), new bytes(0)
        );

        vm.prank(taker);
        (, uint256 amountOut,) = ISwapVM(address(router)).swap(order, 50 ether, takerData);

        assertGt(amountOut, 0, "the fill produced nothing");
        assertEq(token1.balanceOf(taker), takerBefore + amountOut, "taker was not paid");
        assertLt(posm.liquidityOf(TOKEN_ID), liquidityBefore, "the position did not unwind");
        assertEq(vaultFloatBefore, 0, "the vault was supposed to start with no free float");
    }

    /// @notice The vault refuses a payload that does not release what the fill owes.
    function test_Fill_RevertsWhenTheUnwindIsTooSmall() public {
        ISwapVM.Order memory order = _buildOrder(true);
        _ship(order);

        bytes memory takerData = _buildTakerData(
            posm.encodeDecrease(TOKEN_ID, 1, address(vault)), new bytes(0)
        );

        vm.prank(taker);
        vm.expectRevert();
        ISwapVM(address(router)).swap(order, 50 ether, takerData);
    }

    /// @notice The vault refuses a payload that unwinds more of the position than the maker authorised.
    function test_Fill_RevertsWhenTheUnwindExceedsTheCap() public {
        ISwapVM.Order memory order = _buildOrder(true);
        _ship(order);

        uint256 overCap = POSITION_LIQUIDITY * (MAX_UNWIND_PCT + 10) / 100;
        bytes memory takerData = _buildTakerData(
            posm.encodeDecrease(TOKEN_ID, overCap, address(vault)), new bytes(0)
        );

        vm.prank(taker);
        vm.expectRevert();
        ISwapVM(address(router)).swap(order, 50 ether, takerData);
    }

    /// @notice The vault refuses to call anything other than the pinned position manager entry points.
    function test_Fill_RevertsOnAnUnexpectedSelector() public {
        ISwapVM.Order memory order = _buildOrder(true);
        _ship(order);

        bytes memory takerData = _buildTakerData(
            abi.encodeWithSignature("transfer(address,uint256)", taker, 1 ether), new bytes(0)
        );

        vm.prank(taker);
        vm.expectRevert();
        ISwapVM(address(router)).swap(order, 50 ether, takerData);
    }

    /// @notice Only the router may invoke the maker hooks.
    function test_Hooks_RejectAnyCallerButTheRouter() public {
        vm.expectRevert();
        vault.preTransferOut(
            address(vault), taker, address(token0), address(token1), 0, 1, bytes32(0), "", ""
        );
    }

    // ---------------------------------------------------------------------
    // URC-3
    // ---------------------------------------------------------------------

    /// @notice The vault reports under URC-3 and honours the standard's normative invariant.
    /// @dev "For each token, getEffectiveLiquidity SHOULD be less than or equal to getReserves."
    function test_HookStats_EffectiveLiquidityNeverExceedsReserves() public view {
        PoolKey memory key = PoolKey({
            currency0: address(token0),
            currency1: address(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });

        (uint256 reserves0, uint256 reserves1) = vault.getReserves(key);
        (uint256 effective0, uint256 effective1) = vault.getEffectiveLiquidity(key);

        assertLe(effective0, reserves0, "URC-3 invariant violated on token0");
        assertLe(effective1, reserves1, "URC-3 invariant violated on token1");
        assertTrue(vault.supportsInterface(type(IHookStats).interfaceId), "URC-3 not advertised");
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev Builds the Aqua order. The program is either the bare curve, or the curve preceded by 0x92.
    function _buildOrder(bool withInstruction) internal view returns (ISwapVM.Order memory) {
        bytes memory program = abi.encodePacked(uint8(uint256(Opcode.XYCSwap)), uint8(0));

        if (withInstruction) {
            bytes memory args = UnwindPricedBalancesArgsBuilder.build(
                address(posm), TOKEN_ID, HAIRCUT_BPS, MAX_UNWIND_PCT, UNITS_PER_LIQUIDITY
            );
            program = abi.encodePacked(
                uint8(router.OPCODE_UNWIND_PRICED_BALANCE_OUT()), uint8(args.length), args, program
            );
        }

        // A salt keeps the order hash unique so the same economic strategy can be shipped more than once.
        program = abi.encodePacked(
            program, uint8(uint256(Opcode.Salt)), uint8(1), withInstruction ? bytes1(0x01) : bytes1(0x02)
        );

        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: address(vault),
                receiver: address(0),
                tokenA: address(token0),
                tokenB: address(token1),
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: true,
                hasPreTransferOutHook: true,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }

    /// @dev Ships the strategy from the vault. The blob must be `abi.encode(order)` byte for byte, because the
    ///      router looks Aqua balances up under `keccak256(abi.encode(order))`.
    function _ship(ISwapVM.Order memory order) internal {
        address[] memory tokens = new address[](2);
        tokens[0] = address(token0);
        tokens[1] = address(token1);

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = SHIPPED_BALANCE;
        amounts[1] = SHIPPED_BALANCE;

        bytes32 strategyHash = vault.ship(address(router), abi.encode(order), tokens, amounts);
        assertEq(strategyHash, ISwapVM(address(router)).hash(order), "strategyHash must equal orderHash");
    }

    /// @dev Packs taker traits. `isFirstTransferFromTaker` is deliberately left unset so that
    ///      `postTransferIn` runs after the pull, which is what makes a two sided redeposit fundable.
    function _buildTakerData(bytes memory unwindPayload, bytes memory redepositPayload)
        internal
        view
        returns (bytes memory)
    {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: true,
                threshold: "",
                to: address(0),
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: redepositPayload,
                preTransferOutHookData: unwindPayload,
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
    }
}
