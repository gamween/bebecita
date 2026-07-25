// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import { IPermit2 } from "@1inch/solidity-utils/contracts/interfaces/IPermit2.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { IMakerHooks } from "@1inch/swap-vm/src/interfaces/IMakerHooks.sol";

import { IHookStats, PoolKey } from "../interfaces/IHookStats.sol";

/// @title BebecitaVault
/// @notice The maker. Holds a Uniswap liquidity position, almost no free float, and quotes an Aqua order book.
///
/// @dev The settlement window. `SwapVM._transferOut` calls the maker's `preTransferOut` hook and then, on the
///      very next statement, reaches `AQUA.pull`, which is a `safeTransferFrom` out of this contract. That
///      ordering holds in both transfer orders the router supports. `preTransferOut` is therefore the only
///      point in the system guaranteed to run immediately before the tokens leave the maker, which is the
///      window this vault uses to unwind exactly what the fill needs.
///
/// @dev Trust model. The withdrawal calldata is supplied by the taker, per fill, because it is built by the
///      Uniswap LP API against live chain state and cannot be baked into an immutable order. The vault does
///      not trust it. It pins the callee, pins the selector, and verifies the outcome against the amount the
///      VM computed, which the hook receives as a parameter. A taker can therefore choose how to unwind but
///      never whether the maker ends up short, and never what the vault ends up owning.
contract BebecitaVault is IMakerHooks, IHookStats, IERC165 {
    using SafeERC20 for IERC20;

    /// @dev Only the router may invoke maker hooks.
    error UnauthorizedCaller(address caller);
    /// @dev Only the owner may operate the vault.
    error UnauthorizedOwner(address caller);
    /// @dev Hook payload targets a contract other than the pinned position manager.
    error UnexpectedTarget(address target, address expected);
    /// @dev Hook payload calls a selector outside the allowlist.
    error UnexpectedSelector(bytes4 selector);
    /// @dev The external call reverted.
    error PositionCallFailed(bytes returnData);
    /// @dev The unwind did not leave enough of the output token to honour the fill.
    error UnwindShortfall(address token, uint256 balanceAfter, uint256 required);
    /// @dev The payload drained the other token instead of releasing the one owed.
    error CollateralLeak(address token, uint256 balanceBefore, uint256 balanceAfter);
    /// @dev The payload removed more of the position than the maker authorised for one fill.
    error UnwindExceedsCap(uint256 liquidityBefore, uint256 liquidityAfter, uint8 maxUnwindPct);
    /// @dev A redeposit may never reduce the position.
    error RedepositReducedPosition(uint256 liquidityBefore, uint256 liquidityAfter);
    /// @dev Payload shorter than a selector.
    error PayloadTooShort();

    event Shipped(bytes32 indexed strategyHash, address indexed app);
    event Unwound(bytes32 indexed orderHash, address indexed token, uint256 released, uint256 required);
    event Redeposited(bytes32 indexed orderHash, uint256 liquidityBefore, uint256 liquidityAfter);

    /// @notice Official Aqua protocol.
    IAqua public immutable AQUA;
    /// @notice Uniswap v4 PositionManager holding the inventory.
    address public immutable POSITION_MANAGER;
    /// @notice The position backing this vault.
    uint256 public immutable TOKEN_ID;
    /// @notice Operator of the vault.
    address public immutable OWNER;
    /// @notice The only address allowed to invoke the maker hooks.
    address public immutable ROUTER;

    /// @notice Largest share of the position a single fill may unwind, in percent.
    /// @dev Mirrors the granularity of the Uniswap LP API, whose `liquidityPercentageToDecrease` is an
    ///      integer percentage in [1, 100]. A finer cap here would be unenforceable in practice.
    uint8 public maxUnwindPct;

    /// @notice Safety margin applied when reporting effective liquidity, in basis points.
    uint16 public haircutBps;

    /// @notice tokenOut units released per unit of position liquidity, scaled by 1e18.
    uint128 public unitsPerLiquidityE18;

    /// @dev `getPositionLiquidity(uint256)` on the v4 PositionManager.
    bytes4 private constant _GET_POSITION_LIQUIDITY = 0x1efeed33;
    /// @dev `modifyLiquidities(bytes,uint256)`, the entry point the LP API builds against.
    bytes4 private constant _MODIFY_LIQUIDITIES = 0xdd46508f;
    /// @dev `modifyLiquiditiesWithoutUnlock(bytes,bytes[])`.
    bytes4 private constant _MODIFY_LIQUIDITIES_NO_UNLOCK = 0x4afe393c;

    uint256 private constant _BPS = 10_000;
    uint256 private constant _WAD = 1e18;

    modifier onlyOwner() {
        require(msg.sender == OWNER, UnauthorizedOwner(msg.sender));
        _;
    }

    constructor(
        IAqua aqua,
        address router,
        address positionManager,
        uint256 tokenId,
        address owner_,
        uint8 maxUnwindPct_,
        uint16 haircutBps_,
        uint128 unitsPerLiquidityE18_
    ) {
        AQUA = aqua;
        ROUTER = router;
        POSITION_MANAGER = positionManager;
        TOKEN_ID = tokenId;
        OWNER = owner_;
        maxUnwindPct = maxUnwindPct_;
        haircutBps = haircutBps_;
        unitsPerLiquidityE18 = unitsPerLiquidityE18_;
    }

    // ---------------------------------------------------------------------
    // Maker operations
    // ---------------------------------------------------------------------

    /// @notice Open an Aqua strategy from this vault.
    /// @dev `Aqua.ship` is scoped to `msg.sender`, so the vault must ship for itself. On the SwapVM path the
    ///      strategy blob must be `abi.encode(order)` byte for byte, because the router derives the Aqua
    ///      strategy hash as `keccak256(abi.encode(order))` and looks balances up under it. One byte of
    ///      difference and `safeBalances` reverts with no hint that the encoding was the problem.
    function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external
        onlyOwner
        returns (bytes32 strategyHash)
    {
        strategyHash = AQUA.ship(app, strategy, tokens, amounts);
        emit Shipped(strategyHash, app);
    }

    /// @notice Close an Aqua strategy.
    function dock(address app, bytes32 strategyHash, address[] calldata tokens) external onlyOwner {
        AQUA.dock(app, strategyHash, tokens);
    }

    /// @notice Approve Aqua to move a token out of this vault, which is what `Aqua.pull` needs.
    function approveAqua(address token, uint256 amount) external onlyOwner {
        IERC20(token).forceApprove(address(AQUA), amount);
    }

    /// @notice Approve the position manager, which redeposits need.
    function approvePositionManager(address token, uint256 amount) external onlyOwner {
        IERC20(token).forceApprove(POSITION_MANAGER, amount);
    }

    /// @notice Approve an arbitrary spender, used for Permit2 style setup flows returned by the LP API.
    function approve(address token, address spender, uint256 amount) external onlyOwner {
        IERC20(token).forceApprove(spender, amount);
    }

    /// @notice Grant a Permit2 allowance, which is how the v4 PositionManager gets paid for a redeposit.
    /// @dev The position manager settles through Permit2, so an ERC20 approval alone funds nothing. The LP
    ///      API says so in its own output: `/lp/check_approval` with `generatePermitAsTransaction: true`
    ///      returns exactly two calls per token, an ERC20 `approve` to Permit2 and this Permit2 `approve` to
    ///      the position manager. A maker that cannot sign EIP-712 has no other way to obtain that allowance,
    ///      so the second call needs an entry point of its own. Owner only, and the selector is fixed here
    ///      rather than taken from the payload.
    function approveViaPermit2(address permit2, address token, address spender, uint160 amount, uint48 expiration)
        external
        onlyOwner
    {
        IPermit2(permit2).approve(token, spender, amount, expiration);
    }

    /// @notice Update the risk parameters the instruction and the guards read.
    function setRiskParams(uint8 maxUnwindPct_, uint16 haircutBps_, uint128 unitsPerLiquidityE18_)
        external
        onlyOwner
    {
        maxUnwindPct = maxUnwindPct_;
        haircutBps = haircutBps_;
        unitsPerLiquidityE18 = unitsPerLiquidityE18_;
    }

    /// @notice Execute a payload built by the Uniswap LP API, outside of a fill.
    /// @dev Used by the setup script for position creation and by the closing panel for fee collection.
    ///      Still pinned to the position manager.
    function executeOnPositionManager(bytes calldata payload, uint256 value)
        external
        payable
        onlyOwner
        returns (bytes memory)
    {
        return _callPositionManager(payload, value);
    }

    /// @notice Recover anything stranded in the vault.
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------
    // Maker hooks
    // ---------------------------------------------------------------------

    /// @inheritdoc IMakerHooks
    /// @dev The funding hook. Runs one instruction before `AQUA.pull` moves `amountOut` out of this vault.
    function preTransferOut(
        address, /* maker */
        address, /* taker */
        address tokenIn,
        address tokenOut,
        uint256, /* amountIn */
        uint256 amountOut,
        bytes32 orderHash,
        bytes calldata, /* makerData */
        bytes calldata takerData
    ) external override {
        _onlyRouter();
        if (takerData.length == 0) return;

        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 liquidityBefore = _positionLiquidity();

        _callPositionManager(takerData, 0);

        uint256 outAfter = IERC20(tokenOut).balanceOf(address(this));
        uint256 inAfter = IERC20(tokenIn).balanceOf(address(this));
        uint256 liquidityAfter = _positionLiquidity();

        // Guard 1: the unwind must leave enough to honour the amount the VM computed. This is a floor, not a
        // sign check, and it is what makes taker-supplied calldata safe to execute.
        require(outAfter >= outBefore + amountOut, UnwindShortfall(tokenOut, outAfter, outBefore + amountOut));

        // Guard 2: the payload may not drain the other side of the book.
        require(inAfter >= inBefore, CollateralLeak(tokenIn, inBefore, inAfter));

        // Guard 3: a single fill may not unwind more of the position than the maker authorised.
        uint256 removed = liquidityBefore - Math.min(liquidityBefore, liquidityAfter);
        require(
            removed * 100 <= liquidityBefore * maxUnwindPct,
            UnwindExceedsCap(liquidityBefore, liquidityAfter, maxUnwindPct)
        );

        emit Unwound(orderHash, tokenOut, outAfter - outBefore, amountOut);
    }

    /// @inheritdoc IMakerHooks
    /// @dev The refunding hook. With `IS_FIRST_TRANSFER_FROM_TAKER` unset, the router runs this after the
    ///      pull, so the vault owns the taker's input by the time it redeposits. That ordering is what lets
    ///      the redeposit be two sided, which is what keeps the position in range and therefore earning.
    function postTransferIn(
        address, /* maker */
        address, /* taker */
        address, /* tokenIn */
        address, /* tokenOut */
        uint256, /* amountIn */
        uint256, /* amountOut */
        bytes32 orderHash,
        bytes calldata, /* makerData */
        bytes calldata takerData
    ) external override {
        _onlyRouter();
        if (takerData.length == 0) return;

        uint256 liquidityBefore = _positionLiquidity();
        _callPositionManager(takerData, 0);
        uint256 liquidityAfter = _positionLiquidity();

        // Guard 4: a redeposit may only grow the position.
        require(liquidityAfter >= liquidityBefore, RedepositReducedPosition(liquidityBefore, liquidityAfter));

        emit Redeposited(orderHash, liquidityBefore, liquidityAfter);
    }

    /// @inheritdoc IMakerHooks
    function preTransferIn(
        address,
        address,
        address,
        address,
        uint256,
        uint256,
        bytes32,
        bytes calldata,
        bytes calldata
    ) external override {
        _onlyRouter();
    }

    /// @inheritdoc IMakerHooks
    function postTransferOut(
        address,
        address,
        address,
        address,
        uint256,
        uint256,
        bytes32,
        bytes calldata,
        bytes calldata
    ) external override {
        _onlyRouter();
    }

    // ---------------------------------------------------------------------
    // URC-3 reporting
    // ---------------------------------------------------------------------

    /// @inheritdoc IHookStats
    /// @dev Reserves are free float plus the full deployed leg, valued with the maker's conversion factor.
    function getReserves(PoolKey calldata key) external view override returns (uint256 token0, uint256 token1) {
        uint256 deployed = Math.mulDiv(_positionLiquidity(), unitsPerLiquidityE18, _WAD);
        token0 = IERC20(key.currency0).balanceOf(address(this)) + deployed;
        token1 = IERC20(key.currency1).balanceOf(address(this)) + deployed;
    }

    /// @inheritdoc IHookStats
    /// @dev Effective liquidity is what one fill could actually reach: free float plus the capped, haircut
    ///      share of the position. This is the same figure instruction 0x92 clamps `balanceOut` to, so the
    ///      standard's invariant `getEffectiveLiquidity <= getReserves` is enforced inside the VM as well as
    ///      reported here.
    function getEffectiveLiquidity(PoolKey calldata key)
        external
        view
        override
        returns (uint256 token0, uint256 token1)
    {
        uint256 reachable = reachableFromPosition();
        token0 = IERC20(key.currency0).balanceOf(address(this)) + reachable;
        token1 = IERC20(key.currency1).balanceOf(address(this)) + reachable;
    }

    /// @inheritdoc IHookStats
    /// @dev This vault is a maker on another protocol, not a v4 hook, so there is no hook to name. URC-3
    ///      makes this accessor mandatory for conformance while its own motivating cases include contracts
    ///      that keep reserves outside the PoolManager without being hooks. Reported in FEEDBACK.md.
    function hook() external pure override returns (address) {
        return address(0);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IHookStats).interfaceId
            || interfaceId == type(IMakerHooks).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    /// @notice The share of the position a single fill may lean on, after cap and haircut.
    /// @dev Kept public so the dashboard and the tests read the same number the instruction computes.
    function reachableFromPosition() public view returns (uint256) {
        uint256 deployed = Math.mulDiv(_positionLiquidity(), unitsPerLiquidityE18, _WAD);
        uint256 usable = Math.mulDiv(deployed, maxUnwindPct, 100);
        return Math.mulDiv(usable, _BPS - haircutBps, _BPS);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev Hooks are only meaningful when the router invokes them.
    function _onlyRouter() private view {
        require(msg.sender == ROUTER, UnauthorizedCaller(msg.sender));
    }

    /// @dev Pins callee and selector, then forwards. Everything else about the payload is the taker's choice
    ///      and is judged by its effects, not by its shape.
    function _callPositionManager(bytes calldata payload, uint256 value) private returns (bytes memory) {
        require(payload.length >= 4, PayloadTooShort());
        bytes4 selector = bytes4(payload[:4]);
        require(
            selector == _MODIFY_LIQUIDITIES || selector == _MODIFY_LIQUIDITIES_NO_UNLOCK,
            UnexpectedSelector(selector)
        );
        (bool success, bytes memory returnData) = POSITION_MANAGER.call{ value: value }(payload);
        require(success, PositionCallFailed(returnData));
        return returnData;
    }

    /// @dev Current liquidity of the backing position.
    function _positionLiquidity() private view returns (uint256) {
        (bool success, bytes memory result) =
            POSITION_MANAGER.staticcall(abi.encodeWithSelector(_GET_POSITION_LIQUIDITY, TOKEN_ID));
        if (!success || result.length != 32) return 0;
        return abi.decode(result, (uint256));
    }

    /// @notice Accept the position NFT.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}
