// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test, stdError } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { SafeERC20 } from "@1inch/solidity-utils/contracts/libraries/SafeERC20.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { Opcode } from "@1inch/swap-vm/src/libs/OpcodeList.sol";
import { Controls } from "@1inch/swap-vm/src/instructions/Controls.sol";
import { XYCConcentrateArgsBuilder } from "@1inch/swap-vm/src/instructions/XYCConcentrate.sol";

import { BebecitaRouter } from "../src/routers/BebecitaRouter.sol";
import { BebecitaTaker } from "../src/takers/BebecitaTaker.sol";
import { BebecitaVault } from "../src/vault/BebecitaVault.sol";
import { UnwindPricedBalancesArgsBuilder } from "../src/instructions/UnwindPricedBalances.sol";
import { IHookStats, PoolKey } from "../src/interfaces/IHookStats.sol";
import { TestERC20 } from "../src/mocks/TestERC20.sol";
import { MockPositionManager } from "../src/mocks/MockPositionManager.sol";
import { MockStateView } from "../src/mocks/MockStateView.sol";

/// @title BebecitaTest
/// @notice The behaviour of a maker whose inventory lives outside its wallet.
contract BebecitaTest is Test {
    uint256 internal constant TOKEN_ID = 1;
    uint256 internal constant POSITION_LIQUIDITY = 1_000 ether;
    uint256 internal constant SHIPPED_BALANCE = 10_000 ether;
    uint8 internal constant MAX_UNWIND_PCT = 50;
    uint16 internal constant HAIRCUT_BPS = 500;
    uint128 internal constant UNITS_PER_LIQUIDITY = 1e18;

    /// @notice The position is full range and the pool sits at parity, which is the live shape on Sepolia.
    /// @dev At parity inside a symmetric range a unit of liquidity is one of each token, which is why the
    ///      maker's single scalar of 1e18 was honest here and drifts as soon as the pool moves. Both facts get
    ///      their own assertions below.
    int24 internal constant TICK_LOWER = -887220;
    int24 internal constant TICK_UPPER = 887220;
    uint160 internal constant SQRT_PRICE_PARITY = 79228162514264337593543950336;

    /// @notice The bounds the live book ships, in the instruction's 1e18 fixed point, `sqrt(tokenGt/tokenLt)`.
    /// @dev The position funding the book is full range, ticks -887220 to 887220, and full range does not
    ///      survive this fixed point: `sqrt(1.0001^-887220)` is 5.4e-20, which truncates to zero, and
    ///      `XYCConcentrateArgsBuilder.build2D` rejects a zero lower bound. So the range is clamped to the
    ///      widest window the format carries, a factor of 1e9 on the sqrt price either side of spot, which is
    ///      a price window of 1e18 either way and ticks -414486 to 414486. `solver/src/aqua.ts` derives the
    ///      same two numbers from `POST /lp/pool_info` and the position's ticks, and documents the choice.
    ///      At this width the virtual reserves add about a billionth of the real ones, so the curve is
    ///      constant product to nine significant digits and the clamp is what changes, not the price.
    uint256 internal constant SQRT_PRICE_MIN = 1e9;
    uint256 internal constant SQRT_PRICE_MAX = 1e27;

    /// @notice The same program with the range the maker would compile in after re-ranging the position.
    /// @dev Prices 0.25 to 4. Nothing about the instruction changes, only its two arguments, which is the
    ///      point: the book's curve is the range of the position backing it.
    uint256 internal constant NARROW_SQRT_PRICE_MIN = 0.5e18;
    uint256 internal constant NARROW_SQRT_PRICE_MAX = 2e18;

    Aqua internal aqua;
    BebecitaRouter internal router;
    BebecitaVault internal vault;
    MockPositionManager internal posm;
    MockStateView internal stateView;
    TestERC20 internal token0;
    TestERC20 internal token1;
    PoolKey internal poolKey;

    address internal taker = address(uint160(0x7A4E));

    function setUp() public {
        aqua = new Aqua();

        TestERC20 a = new TestERC20("Alpha", "ALPHA", 18);
        TestERC20 b = new TestERC20("Bravo", "BRAVO", 18);
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);

        posm = new MockPositionManager(address(token0), address(token1), UNITS_PER_LIQUIDITY);
        stateView = new MockStateView();
        router = new BebecitaRouter(address(aqua), address(0), address(this), "Bebecita", "1");
        vault = new BebecitaVault(
            IAqua(address(aqua)),
            address(router),
            address(posm),
            address(stateView),
            TOKEN_ID,
            address(this),
            MAX_UNWIND_PCT,
            HAIRCUT_BPS,
            UNITS_PER_LIQUIDITY
        );

        // The pool the position sits in. The vault reads its price and the position's ticks on chain, which is
        // what lets a guard say what a unit of liquidity is worth in each token.
        poolKey = PoolKey({
            currency0: address(token0),
            currency1: address(token1),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        posm.configurePool(poolKey, TICK_LOWER, TICK_UPPER);
        stateView.setPrice(keccak256(abi.encode(poolKey)), SQRT_PRICE_PARITY, 0);

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
    ///      `_92`. The dispatch constant is now `uint256(Opcode._92)` rather than a literal, so the sponsor's
    ///      enum is the single source of truth and this test documents which slot that is rather than pairing
    ///      two hand written numbers.
    function test_InstructionTakesReservedSlotOfBalancesTuningBank() public view {
        assertEq(uint256(Opcode._92), router.OPCODE_UNWIND_PRICED_BALANCE_OUT(), "wrong reserved slot");
        assertEq(router.OPCODE_UNWIND_PRICED_BALANCE_OUT(), 0x92, "the reserved slot is 0x92");
        assertEq(uint256(Opcode.StaticBalances), 0x90, "bank moved");
        assertEq(uint256(Opcode.DynamicBalances), 0x91, "bank moved");
    }

    // ---------------------------------------------------------------------
    // The negative moment, as a test
    // ---------------------------------------------------------------------

    /// @notice Without the instruction, Aqua quotes depth the maker cannot deliver and the swap dies at the end.
    /// @dev This is the failure the whole project exists to close, and it is worth having as an executable
    ///      assertion rather than a slide: the quote succeeds, and the swap reverts inside `Aqua.pull` on the
    ///      `safeTransferFrom` out of an empty wallet. The revert is named, not merely counted:
    ///      `Aqua` settles through the `SafeERC20` of `1inch/solidity-utils`, whose low level path surfaces a
    ///      failed pull as `SafeTransferFromFailed`. Asserting that selector is what makes this test the
    ///      narration it claims to be.
    function test_WithoutInstruction_QuotePassesAndSwapReverts() public {
        ISwapVM.Order memory order = _buildOrder(false);
        _ship(order);

        bytes memory takerData = _buildTakerData(new bytes(0), new bytes(0));

        (, uint256 quotedOut,) = ISwapVM(address(router)).quote(order, 100 ether, takerData);
        assertGt(quotedOut, 0, "quote should succeed against the shipped virtual balance");
        assertEq(token1.balanceOf(address(vault)), 0, "the maker must be empty for this to mean anything");

        vm.prank(taker);
        vm.expectRevert(SafeERC20.SafeTransferFromFailed.selector);
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

    /// @notice A program carrying a haircut above one hundred percent is a named error, not a panic.
    /// @dev The args builder rejects it, so only a hand written program can get there, and the difference
    ///      between `HaircutOutOfRange` and `Panic(0x11)` is the difference between a diagnosis and a shrug.
    function test_Instruction_RejectsAnImpossibleHaircut() public {
        bytes memory args = abi.encodePacked(address(posm), TOKEN_ID, uint16(10_001), MAX_UNWIND_PCT, UNITS_PER_LIQUIDITY);
        bytes memory curveArgs = XYCConcentrateArgsBuilder.build2D(SQRT_PRICE_MIN, SQRT_PRICE_MAX);
        bytes memory program = abi.encodePacked(
            uint8(router.OPCODE_UNWIND_PRICED_BALANCE_OUT()),
            uint8(args.length),
            args,
            uint8(uint256(Opcode.XYCConcentrateSwap)),
            uint8(curveArgs.length),
            curveArgs,
            uint8(uint256(Opcode.Salt)),
            uint8(1),
            bytes1(0x77)
        );

        ISwapVM.Order memory order = _buildOrderFromProgram(program);
        _ship(order);

        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("HaircutOutOfRange(uint16)")), uint16(10_001)));
        ISwapVM(address(router)).quote(order, 50 ether, _buildTakerData("", ""));
    }

    /// @notice Quote and swap agree, one of the two invariants of the core suite that are never skipped.
    /// @dev The instruction is `view`, so it satisfies this structurally rather than by discipline. The other
    ///      never skipped invariant is balance sufficiency, which `CoreInvariants.t.sol` asserts after every
    ///      configurable check, and which is precisely what instruction `0x92` enforces.
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
    /// @dev At the shipped bounds the concentrated curve is constant product to nine significant digits, and
    ///      the instruction lowers `balanceOut` only, so the quote is
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
    // The curve, opcode 0x51
    // ---------------------------------------------------------------------

    /// @notice The curve opcode is the sponsor's, dispatched by their table, with no edit to ours.
    /// @dev `AquaOpcodes._runOpcode` already routes `Opcode.XYCConcentrateSwap` to
    ///      `XYCConcentrate._xycConcentrateGrowLiquidity2D`, and `BebecitaOpcodes` overrides only `0x92` and
    ///      the three `Controls` that Aqua never wired. Nothing in this project touches the opcode table for
    ///      the curve, and the quote below reaching a number is what proves the inherited dispatch works.
    function test_ConcentrateCurveComesFromTheSponsorsTableUntouched() public {
        assertEq(uint256(Opcode.XYCConcentrateSwap), 0x51, "0x51 moved in the opcode table");
        assertTrue(router.OPCODE_UNWIND_PRICED_BALANCE_OUT() != 0x51, "our instruction must not shadow it");

        ISwapVM.Order memory order = _buildOrder(true);
        _ship(order);
        (, uint256 quoted,) = ISwapVM(address(router)).quote(order, 100 ether, _buildTakerData("", ""));
        assertGt(quoted, 0, "0x51 did not price");
    }

    /// @notice The program is `[0x92 unwind][0x51 concentrate][0x02 salt]`, byte for byte.
    /// @dev The order of the first two is forced from both ends. `0x92` requires both amount registers to be
    ///      zero, so it cannot follow a curve, and `0x51` is terminal and reads `balanceOut` after the clamp.
    ///      `solver/src/aqua.ts` emits this same layout, and `yarn aqua` proves it against `router.hash`
    ///      before spending gas.
    function test_ProgramIsUnwindThenConcentrateThenSalt() public view {
        bytes memory data = _buildOrder(true).data;

        // The program starts after the two token addresses, which is where all four slice indexes point.
        uint256 pc = 40;
        assertEq(uint8(data[pc]), 0x92, "first opcode is not the unwind");
        assertEq(uint8(data[pc + 1]), 71, "unwind args are 20 + 32 + 2 + 1 + 16");

        pc += 2 + 71;
        assertEq(uint8(data[pc]), 0x51, "the curve is not XYCConcentrateSwap");
        assertEq(uint8(data[pc + 1]), 64, "concentrate args are two uint256 in 1e18 fixed point");

        pc += 2 + 64;
        assertEq(uint8(data[pc]), uint8(uint256(Opcode.Salt)), "the salt is not last");
        assertEq(data.length, pc + 3, "the program carries something after the salt");
    }

    /// @notice A fill larger than the reachable collateral degrades into an exact partial instead of reverting.
    ///
    /// @dev This is the whole reason for moving off `0x50`, and both halves are asserted here.
    ///
    ///      `XYCSwap` never clamps its own output. In exact-out it computes
    ///      `amountIn = ceilDiv(amountOut * balanceIn, balanceOut - amountOut)`, so once instruction `0x92`
    ///      has lowered `balanceOut` to what the position can actually release, any taker asking for more than
    ///      that underflows that subtraction and gets `Panic(0x11)` out of the VM, with nothing in the revert
    ///      data naming the cause. That panic is asserted by type here rather than by the fact that something
    ///      went wrong.
    ///
    ///      `XYCConcentrate` clamps on `balanceOut` and re-solves the other side for the clamped amount, in
    ///      both directions, since the partial fill work merged into `swap-vm` main. The taker is paid exactly
    ///      the reachable collateral and charged exactly what that costs. `TakerTraitsLib.validate` sanctions
    ///      it: on exact-out it requires `takerAmount >= amountOut`, never equality, so a partial is a legal
    ///      fill rather than a tolerated accident.
    function test_ExactOut_AboveReachableCollateral_IsAnExactPartialInsteadOfARevert() public {
        uint256 reachable = vault.reachableFromPosition();
        uint256 ask = reachable * 2;
        bytes memory takerData = _buildTakerData("", "", false);

        ISwapVM.Order memory onXycSwap = _buildXycSwapOrder(true, 0x03);
        _ship(onXycSwap);
        vm.expectRevert(stdError.arithmeticError);
        ISwapVM(address(router)).quote(onXycSwap, ask, takerData);

        ISwapVM.Order memory onConcentrate = _buildOrder(true);
        _ship(onConcentrate);
        (uint256 amountIn, uint256 amountOut,) = ISwapVM(address(router)).quote(onConcentrate, ask, takerData);

        assertEq(amountOut, reachable, "the partial must be exactly the reachable collateral, not an estimate");
        assertLt(amountOut, ask, "a partial that filled the whole ask is not a partial");
        assertGt(amountIn, 0, "an exact partial still has to be paid for");
    }

    /// @notice On a real range, the clamp also re-solves the input, so the taker pays only for what it gets.
    ///
    /// @dev Same program, same instruction, narrower arguments: this is the book after the maker re-ranges the
    ///      position, and it is where the exact-in half of the clamp becomes reachable. A full range position
    ///      cannot get there, because a constant product curve never pays out its whole reserve, and saying so
    ///      is more useful than a test that hides it.
    ///
    ///      The taker offers far more than the book can absorb. `0x51` pays the whole reachable collateral and
    ///      charges the solved input, which is a fraction of the offer. `0x50` charges the entire offer and
    ///      pays out what the curve happens to give, which is both less collateral and a far worse price.
    function test_ExactIn_ClampedFill_ReSolvesTheInputAndSettles() public {
        uint256 reachable = vault.reachableFromPosition();
        uint256 offered = 3_000 ether;
        token0.mint(taker, offered);

        bytes memory takerData = _buildTakerData(posm.encodeDecrease(TOKEN_ID, 500 ether, address(vault)), "");

        ISwapVM.Order memory order = _buildConcentrateOrder(true, NARROW_SQRT_PRICE_MIN, NARROW_SQRT_PRICE_MAX, 0x05);
        _ship(order);

        (uint256 quotedIn, uint256 quotedOut,) = ISwapVM(address(router)).quote(order, offered, takerData);
        assertEq(quotedOut, reachable, "the clamp must land exactly on the reachable collateral");
        assertLt(quotedIn, offered, "the clamped fill must re-solve the input below what was offered");

        uint256 paidBefore = token0.balanceOf(taker);
        uint256 heldBefore = token1.balanceOf(taker);

        vm.prank(taker);
        (uint256 amountIn, uint256 amountOut,) = ISwapVM(address(router)).swap(order, offered, takerData);

        assertEq(amountIn, quotedIn, "quote and swap diverged on the input");
        assertEq(amountOut, quotedOut, "quote and swap diverged on the output");
        assertEq(paidBefore - token0.balanceOf(taker), amountIn, "the taker paid more than the solved input");
        assertEq(token1.balanceOf(taker) - heldBefore, reachable, "the taker was not paid the whole clamp");

        // The same offer on the curve this project used to ship, for the contrast.
        ISwapVM.Order memory onXycSwap = _buildXycSwapOrder(true, 0x04);
        _ship(onXycSwap);
        (uint256 bareIn, uint256 bareOut,) = ISwapVM(address(router)).quote(onXycSwap, offered, takerData);

        assertEq(bareIn, offered, "0x50 charges the whole offer whatever it can deliver");
        assertLt(bareOut, reachable, "0x50 leaves reachable collateral unsold");
        assertGt(amountOut * bareIn, bareOut * amountIn, "the partial must execute at a better price");
    }

    // ---------------------------------------------------------------------
    // The rewired Controls, executed rather than asserted
    // ---------------------------------------------------------------------

    /// @notice One program that runs `JumpIfDirection`, `Stop` and `Revert` through this router.
    ///
    /// @dev These three opcodes exist in `Controls.sol` and are unreachable from any Aqua program, because
    ///      `AquaOpcodes` never dispatches them. `BebecitaOpcodes` wires them back, and until now that claim
    ///      was asserted in prose and never executed, which is exactly the kind of thing a reviewer is right
    ///      to disbelieve. This program uses all three at once:
    ///
    ///      ```
    ///      pc   0  JumpIfDirection(expect tokenIn < tokenOut, -> 11)
    ///      pc   5  Revert(0xdeadbeef)          reached only in the wrong direction
    ///      pc  11  0x92 unwind
    ///      pc  84  0x51 concentrate
    ///      pc 150  Stop
    ///      pc 152  Revert(0xdeadbeef)          reached only if Stop did not halt
    ///      pc 158  Salt
    ///      ```
    ///
    ///      A fill in the shipped direction proves two things at once: the jump was taken, since the first
    ///      `Revert` did not fire, and `Stop` halted the loop, since the second one did not either. A quote in
    ///      the other direction proves the jump is conditional and that `Revert` reverts with its own payload.
    function test_Controls_JumpIfDirectionStopAndRevertAllExecute() public {
        ISwapVM.Order memory order = _buildControlsOrder();
        _ship(order);

        uint256 takerBefore = token1.balanceOf(taker);
        bytes memory takerData = _buildTakerData(posm.encodeDecrease(TOKEN_ID, 200 ether, address(vault)), "");

        vm.prank(taker);
        (, uint256 amountOut,) = ISwapVM(address(router)).swap(order, 50 ether, takerData);

        assertGt(amountOut, 0, "the jump was not taken, or Stop did not halt before the trailing Revert");
        assertEq(token1.balanceOf(taker), takerBefore + amountOut, "the fill did not settle");

        // The other direction falls through to the guarding `Revert`, with the payload the program carries.
        vm.expectRevert(abi.encodeWithSelector(Controls.InstructionRevert.selector, hex"deadbeef"));
        ISwapVM(address(router)).quote(order, 50 ether, _buildTakerData("", "", true, false));
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
        vm.expectPartialRevert(BebecitaVault.UnwindShortfall.selector);
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
        vm.expectRevert(
            abi.encodeWithSelector(
                BebecitaVault.UnwindExceedsCap.selector,
                POSITION_LIQUIDITY,
                POSITION_LIQUIDITY - overCap,
                MAX_UNWIND_PCT
            )
        );
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
        vm.expectRevert(
            abi.encodeWithSelector(BebecitaVault.UnexpectedSelector.selector, bytes4(hex"a9059cbb"))
        );
        ISwapVM(address(router)).swap(order, 50 ether, takerData);
    }

    /// @notice Guard 2: a payload may release the token the fill owes and still not be allowed to spend the
    ///         other side of the book paying for something else.
    ///
    /// @dev Untested until now, and it is not a theoretical guard: a v4 payload can compose a decrease with an
    ///      increase settled by the maker, so the position gives with one hand and takes with the other. Here
    ///      the payload unwinds 400 of liquidity, routes all of the token1 proceeds to the vault and all of the
    ///      token0 proceeds to the taker, then redeposits 100 paid for by the vault. The output side grows by
    ///      300, so guard 1 is satisfied and the fill looks funded; the input side falls by 100, which is the
    ///      leak, and guard 2 is the only thing that sees it.
    function test_Fill_RevertsWhenThePayloadDrainsTheOtherSideOfTheBook() public {
        ISwapVM.Order memory order = _buildOrder(true);
        _ship(order);

        uint256 decreaseBy = 400 ether;
        uint256 increaseBy = 100 ether;
        token0.mint(address(vault), increaseBy);

        MockPositionManager.Leg[] memory legs = new MockPositionManager.Leg[](3);
        legs[0] = MockPositionManager.Leg(
            posm.KIND_DECREASE(), TOKEN_ID, decreaseBy, address(vault), 0, posm.releaseFor(decreaseBy)
        );
        legs[1] = MockPositionManager.Leg(
            posm.KIND_DECREASE(), TOKEN_ID, 0, taker, posm.releaseFor(decreaseBy), 0
        );
        legs[2] = MockPositionManager.Leg(
            posm.KIND_INCREASE(),
            TOKEN_ID,
            increaseBy,
            address(vault),
            posm.releaseFor(increaseBy),
            posm.releaseFor(increaseBy)
        );

        bytes memory takerData = _buildTakerData(posm.encodeLegs(legs), new bytes(0));

        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(BebecitaVault.CollateralLeak.selector, address(token0), increaseBy, 0)
        );
        ISwapVM(address(router)).swap(order, 50 ether, takerData);
    }

    // ---------------------------------------------------------------------
    // The conservation guard
    // ---------------------------------------------------------------------

    /// @notice Guard 5: a payload may not unwind the position and route the proceeds anywhere but here.
    ///
    /// @dev This is the hole the first four guards left open, and it is the reason this file exists in its
    ///      current shape. The payload removes the entire per fill cap, hands the vault exactly `amountOut` of
    ///      the token the fill owes, and sends the whole remainder of both tokens to the taker. Nothing about
    ///      it is exotic: the real `modifyLiquidities` composes `DECREASE_LIQUIDITY` with `TAKE` naming any
    ///      recipient, so this is one API call away for anyone who reads the v4 Actions list.
    function test_Attack_UnwindThatRoutesTheSurplusToTheTakerIsRejected() public {
        ISwapVM.Order memory order = _buildOrder(true);
        _ship(order);

        (bytes memory payload,) = _divertedUnwind(order);
        bytes memory takerData = _buildTakerData(payload, new bytes(0));

        vm.prank(taker);
        vm.expectPartialRevert(BebecitaVault.UnwindValueDiverted.selector);
        ISwapVM(address(router)).swap(order, 50 ether, takerData);
    }

    /// @notice The same payload satisfies guards 1, 2 and 3, which is what makes guard 5 a fix rather than a
    ///         belt on top of a working set.
    ///
    /// @dev This test proves the vulnerability was real. It executes the attacker's payload directly against
    ///      the position manager, as the vault, measures exactly what the four original guards would have
    ///      measured, and asserts that every one of them holds:
    ///
    ///        guard 1, the output balance grew by at least `amountOut`, met exactly rather than generously;
    ///        guard 2, the input balance did not shrink, met with equality because the released token0 never
    ///                 arrived at all, and a balance that never moves cannot fall;
    ///        guard 3, the liquidity removed is exactly `maxUnwindPct`, so the cap is met and not exceeded.
    ///
    ///      Then it rolls the state back and runs the same payload through the real fill, where guard 5 stops
    ///      it. Repeat the first half with dust sized fills and the position drains at `maxUnwindPct` per
    ///      fill, which is the whole finding in one sentence.
    function test_Attack_WouldHavePassedTheFirstThreeGuards() public {
        ISwapVM.Order memory order = _buildOrder(true);
        _ship(order);

        (bytes memory payload, uint256 amountOut) = _divertedUnwind(order);

        uint256 snapshot = vm.snapshotState();

        uint256 outBefore = token1.balanceOf(address(vault));
        uint256 inBefore = token0.balanceOf(address(vault));
        uint256 liquidityBefore = posm.liquidityOf(TOKEN_ID);

        vm.prank(address(vault));
        (bool ok,) = address(posm).call(payload);
        assertTrue(ok, "the diverting payload is a legal position manager call");

        uint256 outAfter = token1.balanceOf(address(vault));
        uint256 inAfter = token0.balanceOf(address(vault));
        uint256 removed = liquidityBefore - posm.liquidityOf(TOKEN_ID);

        assertEq(outAfter, outBefore + amountOut, "guard 1 is met exactly, which is all a floor asks");
        assertEq(inAfter, inBefore, "guard 2 holds with equality, because the released token0 never arrived");
        assertLe(removed * 100, liquidityBefore * MAX_UNWIND_PCT, "guard 3 caps liquidity, and the cap is met");

        // And what the taker walked away with, which is what none of those three could see.
        assertEq(token0.balanceOf(taker) - 1_000 ether, posm.releaseFor(removed), "the whole token0 leg diverted");
        assertEq(token1.balanceOf(taker), posm.releaseFor(removed) - amountOut, "and the token1 surplus with it");

        vm.revertToState(snapshot);

        vm.prank(taker);
        vm.expectPartialRevert(BebecitaVault.UnwindValueDiverted.selector);
        ISwapVM(address(router)).swap(order, 50 ether, _buildTakerData(payload, new bytes(0)));
    }

    /// @notice An honest fill still settles, which is the other half of the guard being useful.
    /// @dev A conservation check that reverts on the payload the Uniswap API builds would be worse than no
    ///      check at all, so the ordinary path is asserted right beside the attack: full proceeds to the vault,
    ///      a surplus kept as float, and the fill goes through.
    function test_ConservationGuard_LeavesTheHonestUnwindAlone() public {
        ISwapVM.Order memory order = _buildOrder(true);
        _ship(order);

        uint256 unwind = POSITION_LIQUIDITY * MAX_UNWIND_PCT / 100;
        bytes memory takerData = _buildTakerData(posm.encodeDecrease(TOKEN_ID, unwind, address(vault)), "");

        vm.prank(taker);
        (, uint256 amountOut,) = ISwapVM(address(router)).swap(order, 50 ether, takerData);

        assertGt(amountOut, 0, "the honest fill must still settle at the full cap");
        assertEq(
            token1.balanceOf(address(vault)),
            posm.releaseFor(unwind) - amountOut,
            "the token1 surplus stays with the maker as float"
        );
        assertEq(token0.balanceOf(address(vault)), posm.releaseFor(unwind) + 50 ether, "the token0 leg stayed too");
    }

    // ---------------------------------------------------------------------
    // The redeposit, which nothing used to exercise
    // ---------------------------------------------------------------------

    /// @notice `postTransferIn` puts the taker's input back into the position, in the same transaction.
    ///
    /// @dev Never executed until now: every test passed an empty redeposit payload, which makes the hook
    ///      return on its first line, so `MockPositionManager.encodeIncrease` was dead code and guard 4 was
    ///      unreachable. This is the second half of the settlement loop the README draws, and the ordering it
    ///      depends on is the reason `IS_FIRST_TRANSFER_FROM_TAKER` is pinned to zero: the hook runs after the
    ///      push, so the vault owns the taker's input by the time it redeposits, which is what makes a two
    ///      sided deposit fundable at all.
    function test_Redeposit_PutsTheInventoryBackToWorkInTheSameTransaction() public {
        ISwapVM.Order memory order = _buildOrder(true);
        _ship(order);

        uint256 unwind = 200 ether;
        uint256 redeposit = 50 ether;
        bytes memory takerData = _buildTakerData(
            posm.encodeDecrease(TOKEN_ID, unwind, address(vault)),
            posm.encodeIncrease(TOKEN_ID, redeposit, address(vault))
        );

        uint256 liquidityBefore = posm.liquidityOf(TOKEN_ID);

        vm.recordLogs();
        vm.prank(taker);
        (, uint256 amountOut,) = ISwapVM(address(router)).swap(order, 50 ether, takerData);

        assertGt(amountOut, 0, "the fill produced nothing");
        assertEq(
            posm.liquidityOf(TOKEN_ID),
            liquidityBefore - unwind + redeposit,
            "the position did not come back up by the redeposit"
        );
        assertEq(
            token1.balanceOf(address(vault)),
            posm.releaseFor(unwind) - amountOut - posm.releaseFor(redeposit),
            "the redeposit was not paid out of the vault's own float"
        );
    }

    /// @notice Guard 4: a redeposit may only grow the position.
    /// @dev Also untested until now, for the same reason. The taker supplies this calldata too, so nothing
    ///      stops it from putting a decrease in the redeposit slice and unwinding a second time after the
    ///      first cap has already been spent. The hook compares liquidity across its own call and refuses.
    function test_Redeposit_RevertsWhenItReducesThePosition() public {
        ISwapVM.Order memory order = _buildOrder(true);
        _ship(order);

        bytes memory takerData = _buildTakerData(
            posm.encodeDecrease(TOKEN_ID, 200 ether, address(vault)),
            posm.encodeDecrease(TOKEN_ID, 100 ether, address(vault))
        );

        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(
                BebecitaVault.RedepositReducedPosition.selector, 800 ether, 700 ether
            )
        );
        ISwapVM(address(router)).swap(order, 50 ether, takerData);
    }

    // ---------------------------------------------------------------------
    // Hook access control
    // ---------------------------------------------------------------------

    /// @notice Only the router may invoke the maker hooks. All four of them.
    /// @dev Three of these were uncovered. `preTransferIn` and `postTransferOut` do nothing but this check, so
    ///      a missing modifier on either would have been invisible, and `postTransferIn` executes taker
    ///      supplied calldata against the position manager, so a missing one there would be the whole vault.
    function test_Hooks_RejectAnyCallerButTheRouter() public {
        bytes memory expected = abi.encodeWithSelector(BebecitaVault.UnauthorizedCaller.selector, address(this));

        vm.expectRevert(expected);
        vault.preTransferOut(address(vault), taker, address(token0), address(token1), 0, 1, bytes32(0), "", "");

        vm.expectRevert(expected);
        vault.postTransferIn(address(vault), taker, address(token0), address(token1), 0, 1, bytes32(0), "", "");

        vm.expectRevert(expected);
        vault.preTransferIn(address(vault), taker, address(token0), address(token1), 0, 1, bytes32(0), "", "");

        vm.expectRevert(expected);
        vault.postTransferOut(address(vault), taker, address(token0), address(token1), 0, 1, bytes32(0), "", "");
    }

    /// @notice And the taker cannot reach them by pretending to be the router either.
    function test_Hooks_RejectTheTakerItself() public {
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BebecitaVault.UnauthorizedCaller.selector, taker));
        vault.preTransferOut(address(vault), taker, address(token0), address(token1), 0, 1, bytes32(0), "", "");
    }

    // ---------------------------------------------------------------------
    // URC-3
    // ---------------------------------------------------------------------

    /// @notice The vault reports under URC-3 and honours the standard's normative invariant.
    /// @dev "For each token, getEffectiveLiquidity SHOULD be less than or equal to getReserves."
    function test_HookStats_EffectiveLiquidityNeverExceedsReserves() public view {
        (uint256 reserves0, uint256 reserves1) = vault.getReserves(poolKey);
        (uint256 effective0, uint256 effective1) = vault.getEffectiveLiquidity(poolKey);

        assertLe(effective0, reserves0, "URC-3 invariant violated on token0");
        assertLe(effective1, reserves1, "URC-3 invariant violated on token1");
        assertTrue(vault.supportsInterface(type(IHookStats).interfaceId), "URC-3 not advertised");
    }

    /// @notice At parity the two sides are equal, which is the only case the old scalar ever got right.
    function test_HookStats_AtParityTheTwoSidesMatchThePosition() public view {
        (uint256 reserves0, uint256 reserves1) = vault.getReserves(poolKey);

        assertApproxEqAbs(reserves0, POSITION_LIQUIDITY, 1e6, "token0 reserves at parity");
        assertApproxEqAbs(reserves1, POSITION_LIQUIDITY, 1e6, "token1 reserves at parity");
    }

    /// @notice Move the pool and the report moves with it, per token, which the old one could not do.
    ///
    /// @dev The previous implementation credited `liquidity * unitsPerLiquidityE18` to both sides, so it
    ///      reported the same number for token0 and token1 whatever the price was. That is right at parity and
    ///      wrong everywhere else, and it is wrong in the dangerous direction on whichever side the pool has
    ///      moved away from. At a price of four a full range unit of liquidity is worth half a token0 and two
    ///      token1, and the report now says so.
    function test_HookStats_FollowsThePoolPriceOnEachSideSeparately() public {
        stateView.setPrice(keccak256(abi.encode(poolKey)), SQRT_PRICE_PARITY * 2, 13863);

        (uint256 reserves0, uint256 reserves1) = vault.getReserves(poolKey);

        assertApproxEqAbs(reserves0, POSITION_LIQUIDITY / 2, 1e6, "token0 at a price of four");
        assertApproxEqAbs(reserves1, POSITION_LIQUIDITY * 2, 1e6, "token1 at a price of four");
        assertGt(reserves1, reserves0 * 3, "the two sides must separate as the pool moves");

        // The maker's scalar does not follow, and that is the drift `yarn rebalance` prints and
        // `docs/ARCHITECTURE.md` documents. The report is the on chain truth; the scalar is a parameter.
        assertEq(
            vault.reachableFromPosition(),
            POSITION_LIQUIDITY * MAX_UNWIND_PCT / 100 * (10_000 - HAIRCUT_BPS) / 10_000,
            "the instruction's scalar is not supposed to move on its own"
        );
    }

    /// @notice Asked about a pool that is not the one backing the position, the vault refuses to answer.
    /// @dev URC-3's conformance list is written around a named pool, and a reporter that answers for any key
    ///      handed to it is reporting somebody else's reserves. The float lookups alone would have made the
    ///      old implementation return a plausible looking number for an unrelated pair.
    function test_HookStats_RefusesAPoolKeyThatIsNotTheBackingPosition() public {
        PoolKey memory other = PoolKey({
            currency0: address(token0),
            currency1: address(token1),
            fee: 500,
            tickSpacing: 10,
            hooks: address(0)
        });

        bytes memory expected = abi.encodeWithSelector(
            BebecitaVault.UnexpectedPool.selector,
            keccak256(abi.encode(poolKey)),
            keccak256(abi.encode(other))
        );

        vm.expectRevert(expected);
        vault.getReserves(other);

        vm.expectRevert(expected);
        vault.getEffectiveLiquidity(other);
    }

    /// @notice Free float is part of the reserves, on the side it actually sits on.
    function test_HookStats_CountsFreeFloatOnTheRightSide() public {
        (uint256 before0, uint256 before1) = vault.getReserves(poolKey);
        token1.mint(address(vault), 123 ether);
        (uint256 after0, uint256 after1) = vault.getReserves(poolKey);

        assertEq(after0, before0, "float on one side must not appear on the other");
        assertEq(after1, before1 + 123 ether, "float on the side it sits on");
    }

    // ---------------------------------------------------------------------
    // Two fills of one position, in one transaction
    // ---------------------------------------------------------------------

    /// @notice Two strategies of the same maker, filled back to back, and the second prices against what the
    ///         first one left.
    ///
    /// @dev This is the composition Aqua cannot see. `AQUA.safeBalances` is keyed by order hash, so the two
    ///      strategies below carry two independent virtual balances of 10,000 each while one position of 1,000
    ///      liquidity backs both. Nothing in Aqua relates them. Instruction `0x92` does, because it reads
    ///      `getPositionLiquidity` and the maker's float at execution time rather than trusting what was
    ///      shipped, so the second fill is quoted against a position the first fill has already drawn on.
    ///
    ///      Every figure below is derived rather than picked. The first fill unwinds the whole per fill cap,
    ///      500, is paid the clamp of 475, and redeposits the 25 of surplus, which is the settlement loop the
    ///      README draws. That leaves 525 of liquidity, so the second fill's clamp is `_reachable(525)`, and
    ///      the assertion is equality with that number and not merely that it went down.
    function test_TwoFills_InOneTransaction_TheSecondPricesAgainstWhatTheFirstLeft() public {
        BebecitaTaker composing = _composingTaker();

        ISwapVM.Order memory first = _narrowOrder(0x11);
        ISwapVM.Order memory second = _narrowOrder(0x12);
        _ship(first);
        _ship(second);

        uint256 cap = POSITION_LIQUIDITY * MAX_UNWIND_PCT / 100;
        uint256 firstOut = _reachable(POSITION_LIQUIDITY);
        uint256 redeposit = cap - firstOut;
        uint256 liquidityAfterFirst = POSITION_LIQUIDITY - cap + redeposit;
        uint256 secondOut = _reachable(liquidityAfterFirst);
        uint256 secondCap = liquidityAfterFirst * MAX_UNWIND_PCT / 100;

        BebecitaTaker.Fill[] memory fills = new BebecitaTaker.Fill[](2);
        fills[0] = BebecitaTaker.Fill({
            order: first,
            amount: 3_000 ether,
            takerTraitsAndData: _buildTakerData(
                posm.encodeDecrease(TOKEN_ID, cap, address(vault)),
                posm.encodeIncrease(TOKEN_ID, redeposit, address(vault))
            )
        });
        fills[1] = BebecitaTaker.Fill({
            order: second,
            amount: 3_000 ether,
            takerTraitsAndData: _buildTakerData(posm.encodeDecrease(TOKEN_ID, secondCap, address(vault)), "")
        });

        uint256[] memory amountsOut = composing.fillAll(fills);

        assertEq(amountsOut[0], firstOut, "the first fill must land on the clamp the whole position supports");
        assertEq(amountsOut[1], secondOut, "the second fill must land on the clamp the first one left behind");
        assertLt(amountsOut[1], amountsOut[0], "a second fill against a drawn down position cannot be as deep");
        assertEq(token1.balanceOf(address(composing)), firstOut + secondOut, "both payouts landed on the taker");
        assertEq(posm.liquidityOf(TOKEN_ID), liquidityAfterFirst - secondCap, "the position trace does not add up");

        // The maker's shipped balance was never the constraint, which is the point: twice the clamp is a
        // fraction of what Aqua would have let these two strategies promise between them.
        assertLt(firstOut + secondOut, SHIPPED_BALANCE, "the two clamps must stay under one shipped balance");

        composing.sweep(address(token1), address(this), firstOut + secondOut);
        assertEq(token1.balanceOf(address(composing)), 0, "the taker must not keep the proceeds it collected");
    }

    /// @notice The per fill cap is measured against the position as it stands, so two fills cannot combine
    ///         into a withdrawal neither of them was allowed to make.
    ///
    /// @dev Guard 3 reads liquidity at hook entry, which is what makes it a per fill cap rather than a per
    ///      transaction one. The first fill removes half of 1,000 and the second asks for the same absolute
    ///      size, which is all of what is left. The cap is refused against the reduced figure, so unwinding
    ///      `maxUnwindPct` twice takes half and then half of the remainder, and iterating never reaches the
    ///      whole position however many fills a transaction carries.
    function test_TwoFills_ThePerFillCapMeasuresTheAlreadyReducedPosition() public {
        BebecitaTaker composing = _composingTaker();

        ISwapVM.Order memory first = _narrowOrder(0x13);
        ISwapVM.Order memory second = _narrowOrder(0x14);
        _ship(first);
        _ship(second);

        uint256 cap = POSITION_LIQUIDITY * MAX_UNWIND_PCT / 100;
        bytes memory unwindTheCap = posm.encodeDecrease(TOKEN_ID, cap, address(vault));

        BebecitaTaker.Fill[] memory fills = new BebecitaTaker.Fill[](2);
        fills[0] = BebecitaTaker.Fill({
            order: first,
            amount: 3_000 ether,
            takerTraitsAndData: _buildTakerData(unwindTheCap, "")
        });
        fills[1] = BebecitaTaker.Fill({
            order: second,
            amount: 3_000 ether,
            takerTraitsAndData: _buildTakerData(unwindTheCap, "")
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                BebecitaVault.UnwindExceedsCap.selector, POSITION_LIQUIDITY - cap, uint256(0), MAX_UNWIND_PCT
            )
        );
        composing.fillAll(fills);
    }

    /// @notice A second fill started inside the first one's settlement window settles, and it settles first.
    ///
    /// @dev The window is the one `BebecitaVault` documents: `SwapVM.sol:316-319` fires
    ///      `preTransferOutCallback` on the taker after the maker's `preTransferOut` hook and before
    ///      `AQUA.pull`, so the inner fill runs while the outer fill's collateral is unwound and not yet paid
    ///      out. This is the shape that needs the router's reentrancy guard to be keyed by order hash, since a
    ///      global guard would refuse the inner `swap` outright.
    ///
    ///      Nesting is proven by the log order rather than asserted: two `Swapped` events come out of one
    ///      call, and the inner order's is the first of the two, which cannot happen if the fills ran back to
    ///      back.
    function test_NestedFill_SettlesInsideTheOuterFillsSettlementWindow() public {
        BebecitaTaker composing = _composingTaker();

        ISwapVM.Order memory outer = _narrowOrder(0x15);
        ISwapVM.Order memory inner = _narrowOrder(0x16);
        _ship(outer);
        _ship(inner);

        uint256 outerUnwind = POSITION_LIQUIDITY * MAX_UNWIND_PCT / 100;
        uint256 innerUnwind = (POSITION_LIQUIDITY - outerUnwind) * MAX_UNWIND_PCT / 100;
        uint256 innerAsk = 200 ether;

        BebecitaTaker.Fill memory nested = BebecitaTaker.Fill({
            order: inner,
            amount: innerAsk,
            takerTraitsAndData: _buildTakerData(
                posm.encodeDecrease(TOKEN_ID, innerUnwind, address(vault)), "", false
            )
        });

        BebecitaTaker.Fill[] memory fills = new BebecitaTaker.Fill[](1);
        fills[0] = BebecitaTaker.Fill({
            order: outer,
            amount: 3_000 ether,
            takerTraitsAndData: _buildNestedTakerData(
                posm.encodeDecrease(TOKEN_ID, outerUnwind, address(vault)), abi.encode(nested)
            )
        });

        vm.recordLogs();
        uint256[] memory amountsOut = composing.fillAll(fills);

        assertEq(amountsOut[0], _reachable(POSITION_LIQUIDITY), "the outer fill was not clamped as usual");
        assertEq(
            token1.balanceOf(address(composing)),
            amountsOut[0] + innerAsk,
            "both fills must have paid the same taker in the same transaction"
        );
        assertEq(
            posm.liquidityOf(TOKEN_ID),
            POSITION_LIQUIDITY - outerUnwind - innerUnwind,
            "both unwinds must have come out of the one position"
        );

        bytes32[] memory settled = _swappedOrderHashes();
        assertEq(settled.length, 2, "one call must have produced two settlements");
        assertEq(settled[0], ISwapVM(address(router)).hash(inner), "the inner fill did not settle first");
        assertEq(settled[1], ISwapVM(address(router)).hash(outer), "the outer fill did not settle last");
    }

    /// @notice The float the clamp counts cannot fund two fills, and guard 1 is what says so.
    ///
    /// @dev The one interaction that composition actually creates. `0x92` adds the maker's free float to the
    ///      reachable share of the position, and inside the settlement window that float is the outer fill's
    ///      own unwind, sitting in the vault because `AQUA.pull` has not run yet. So the inner fill is quoted
    ///      737.5 rather than the 237.5 its own share of the position is worth, and a taker asking for all of it
    ///      would be paid twice out of one withdrawal.
    ///
    ///      Nothing about the reentrancy guard stops that, and neither does the cap: the inner unwind below is
    ///      exactly `maxUnwindPct` of what is left. Guard 1 stops it, because it is a delta and not a level.
    ///      It requires the payload to raise the maker's balance by the whole `amountOut`, so tokens that were
    ///      already there when the hook started cannot count towards a second fill. The transaction reverts,
    ///      the maker pays nothing, and the taker pays the gas.
    function test_NestedFill_CannotBeFundedTwiceOutOfTheSameFloat() public {
        BebecitaTaker composing = _composingTaker();

        ISwapVM.Order memory outer = _narrowOrder(0x17);
        ISwapVM.Order memory inner = _narrowOrder(0x18);
        _ship(outer);
        _ship(inner);

        uint256 outerUnwind = POSITION_LIQUIDITY * MAX_UNWIND_PCT / 100;
        uint256 innerUnwind = (POSITION_LIQUIDITY - outerUnwind) * MAX_UNWIND_PCT / 100;

        // What the inner fill is quoted: the outer fill's proceeds, still in the vault, plus the reachable
        // part of what the position has left. And what its own payload can actually deliver.
        uint256 float = posm.releaseFor(outerUnwind);
        uint256 innerClamp = float + _reachable(POSITION_LIQUIDITY - outerUnwind);
        uint256 delivered = float + posm.releaseFor(innerUnwind);

        BebecitaTaker.Fill memory nested = BebecitaTaker.Fill({
            order: inner,
            amount: 3_000 ether,
            takerTraitsAndData: _buildTakerData(posm.encodeDecrease(TOKEN_ID, innerUnwind, address(vault)), "")
        });

        BebecitaTaker.Fill[] memory fills = new BebecitaTaker.Fill[](1);
        fills[0] = BebecitaTaker.Fill({
            order: outer,
            amount: 3_000 ether,
            takerTraitsAndData: _buildNestedTakerData(
                posm.encodeDecrease(TOKEN_ID, outerUnwind, address(vault)), abi.encode(nested)
            )
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                BebecitaVault.UnwindShortfall.selector, address(token1), delivered, float + innerClamp
            )
        );
        composing.fillAll(fills);
    }

    /// @notice The taker's callbacks answer to the router and to nothing else.
    /// @dev `preTransferOutCallback` starts a fill, so anyone who could call it directly could make this
    ///      contract spend its allowance on an order of their choosing. `preTransferInCallback` is refused
    ///      outright because no traits this contract fills with ever request it.
    function test_ComposingTaker_CallbacksRejectAnyCallerButTheRouter() public {
        BebecitaTaker composing = _composingTaker();

        vm.expectRevert(abi.encodeWithSelector(BebecitaTaker.UnauthorizedCaller.selector, address(this)));
        composing.preTransferOutCallback(
            address(vault), address(composing), address(token0), address(token1), 0, 1, bytes32(0), ""
        );

        vm.expectRevert(BebecitaTaker.UnrequestedCallback.selector);
        composing.preTransferInCallback(
            address(vault), address(composing), address(token0), address(token1), 0, 1, bytes32(0), ""
        );
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev A funded taker contract, approved for the input side the router pulls.
    function _composingTaker() internal returns (BebecitaTaker composing) {
        composing = new BebecitaTaker(address(router), address(this));
        token0.mint(address(composing), 20_000 ether);
        composing.approveRouter(address(token0), type(uint256).max);
    }

    /// @dev What one fill may lean on at a given position size, cap then haircut, as `0x92` computes it.
    function _reachable(uint256 liquidity) internal pure returns (uint256) {
        return liquidity * MAX_UNWIND_PCT / 100 * (10_000 - HAIRCUT_BPS) / 10_000;
    }

    /// @dev The book after the maker re-ranges, which is the shape where the exact-in clamp is reachable and
    ///      a fill therefore lands on a figure worth asserting.
    function _narrowOrder(bytes1 salt) internal view returns (ISwapVM.Order memory) {
        return _buildConcentrateOrder(true, NARROW_SQRT_PRICE_MIN, NARROW_SQRT_PRICE_MAX, salt);
    }

    /// @dev The order hashes the router settled, in the order it settled them.
    /// @dev `Swapped` declares no indexed parameter, so the hash travels in the data rather than in a topic.
    function _swappedOrderHashes() internal returns (bytes32[] memory hashes) {
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 count;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (_isSwapped(logs[i])) ++count;
        }

        hashes = new bytes32[](count);
        uint256 next;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (!_isSwapped(logs[i])) continue;
            (hashes[next++],,,,,,) =
                abi.decode(logs[i].data, (bytes32, address, address, address, address, uint256, uint256));
        }
    }

    /// @dev A settlement of this router, as opposed to the hook and Aqua events a fill also emits.
    function _isSwapped(Vm.Log memory entry) internal view returns (bool) {
        if (entry.emitter != address(router) || entry.topics.length == 0) return false;
        return entry.topics[0] == keccak256("Swapped(bytes32,address,address,address,address,uint256,uint256)");
    }

    /// @dev The attack payload, and the `amountOut` it is sized against.
    ///
    ///      One decrease of the entire per fill cap, split into two routings of the same proceeds: exactly
    ///      `amountOut` of token1 to the vault, and everything else, both tokens, to the taker. The mock
    ///      refuses to route more or less than the decrease released, so this is a diversion and never a mint.
    function _divertedUnwind(ISwapVM.Order memory order)
        internal
        view
        returns (bytes memory payload, uint256 amountOut)
    {
        (, amountOut,) = ISwapVM(address(router)).quote(order, 50 ether, _buildTakerData("", ""));

        uint256 cap = POSITION_LIQUIDITY * MAX_UNWIND_PCT / 100;
        uint256 released = posm.releaseFor(cap);

        MockPositionManager.Leg[] memory legs = new MockPositionManager.Leg[](2);
        legs[0] = MockPositionManager.Leg(posm.KIND_DECREASE(), TOKEN_ID, cap, address(vault), 0, amountOut);
        legs[1] =
            MockPositionManager.Leg(posm.KIND_DECREASE(), TOKEN_ID, 0, taker, released, released - amountOut);

        payload = posm.encodeLegs(legs);
    }

    /// @dev The shipped program: `0x92` then `0x51` parameterised as the live book is, then the salt.
    function _buildOrder(bool withInstruction) internal view returns (ISwapVM.Order memory) {
        return _buildConcentrateOrder(
            withInstruction, SQRT_PRICE_MIN, SQRT_PRICE_MAX, withInstruction ? bytes1(0x01) : bytes1(0x02)
        );
    }

    /// @dev The concentrated curve, opcode `0x51`, with arguments built by the sponsor's own builder so the
    ///      64 byte layout is theirs and not a transcription. `solver/src/aqua.ts` emits the same bytes, and
    ///      that claim is checked on chain every time `yarn aqua` compares its hash against `router.hash`.
    function _buildConcentrateOrder(
        bool withInstruction,
        uint256 sqrtPriceMin,
        uint256 sqrtPriceMax,
        bytes1 salt
    ) internal view returns (ISwapVM.Order memory) {
        bytes memory curveArgs = XYCConcentrateArgsBuilder.build2D(sqrtPriceMin, sqrtPriceMax);
        bytes memory curve = abi.encodePacked(
            uint8(uint256(Opcode.XYCConcentrateSwap)), uint8(curveArgs.length), curveArgs
        );
        return _buildOrderOnCurve(withInstruction, curve, salt);
    }

    /// @dev The curve this project used to ship, opcode `0x50`, kept as the contrast the new tests measure.
    function _buildXycSwapOrder(bool withInstruction, bytes1 salt)
        internal
        view
        returns (ISwapVM.Order memory)
    {
        return _buildOrderOnCurve(withInstruction, abi.encodePacked(uint8(uint256(Opcode.XYCSwap)), uint8(0)), salt);
    }

    /// @dev Builds the Aqua order. The program is either the bare curve, or the curve preceded by 0x92.
    function _buildOrderOnCurve(bool withInstruction, bytes memory curve, bytes1 salt)
        internal
        view
        returns (ISwapVM.Order memory)
    {
        bytes memory program = curve;

        if (withInstruction) {
            program = abi.encodePacked(_unwindInstruction(), program);
        }

        // A salt keeps the order hash unique so the same economic strategy can be shipped more than once.
        program = abi.encodePacked(program, uint8(uint256(Opcode.Salt)), uint8(1), salt);

        return _buildOrderFromProgram(program);
    }

    /// @dev `[0x92][args]`, the instruction as every program here carries it.
    function _unwindInstruction() internal view returns (bytes memory) {
        bytes memory args = UnwindPricedBalancesArgsBuilder.build(
            address(posm), TOKEN_ID, HAIRCUT_BPS, MAX_UNWIND_PCT, UNITS_PER_LIQUIDITY
        );
        return abi.encodePacked(uint8(router.OPCODE_UNWIND_PRICED_BALANCE_OUT()), uint8(args.length), args);
    }

    /// @dev The program exercising the three rewired `Controls`. Offsets are asserted by the test that uses it.
    function _buildControlsOrder() internal view returns (ISwapVM.Order memory) {
        bytes memory curveArgs = XYCConcentrateArgsBuilder.build2D(SQRT_PRICE_MIN, SQRT_PRICE_MAX);

        bytes memory program = abi.encodePacked(
            // pc 0: five bytes. Jump past the guarding revert when tokenIn < tokenOut, which is the direction
            // the book is shipped for.
            uint8(uint256(Opcode.JumpIfDirection)), uint8(3), bytes1(0x01), uint16(11),
            // pc 5: six bytes. Only reachable in the other direction.
            uint8(uint256(Opcode.Revert)), uint8(4), bytes4(0xdeadbeef),
            // pc 11: the ordinary program.
            _unwindInstruction(),
            uint8(uint256(Opcode.XYCConcentrateSwap)), uint8(curveArgs.length), curveArgs,
            // pc 150: halt, so nothing below ever runs.
            uint8(uint256(Opcode.Stop)), uint8(0),
            // pc 152: reachable only if Stop did not stop.
            uint8(uint256(Opcode.Revert)), uint8(4), bytes4(0xdeadbeef),
            // pc 158: unreachable, and there only to keep the order hash unique.
            uint8(uint256(Opcode.Salt)), uint8(1), bytes1(0x09)
        );

        return _buildOrderFromProgram(program);
    }

    /// @dev Wraps a program into the maker traits this book always uses.
    function _buildOrderFromProgram(bytes memory program) internal view returns (ISwapVM.Order memory) {
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
        return _buildTakerData(unwindPayload, redepositPayload, true, true);
    }

    /// @dev The same, with the direction of the quote made explicit. Exact-out is where `0x50` panics.
    function _buildTakerData(bytes memory unwindPayload, bytes memory redepositPayload, bool isExactIn)
        internal
        view
        returns (bytes memory)
    {
        return _buildTakerData(unwindPayload, redepositPayload, isExactIn, true);
    }

    /// @dev The same, asking the router to call back into the taker between the maker's hook and the pull.
    ///      `preTransferOutCallbackData` carries the fill the taker will run from inside that window.
    function _buildNestedTakerData(bytes memory unwindPayload, bytes memory callbackData)
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
                hasPreTransferOutCallback: true,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: unwindPayload,
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: callbackData,
                instructionsArgs: "",
                signature: ""
            })
        );
    }

    /// @dev And with the swap direction made explicit, which is what `JumpIfDirection` reads.
    function _buildTakerData(
        bytes memory unwindPayload,
        bytes memory redepositPayload,
        bool isExactIn,
        bool isAToB
    ) internal view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: isExactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: isAToB,
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
