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
import { LiquidityAmounts, TickMath } from "../libraries/LiquidityAmounts.sol";

/// @title BebecitaVault
/// @notice The maker. Holds a Uniswap liquidity position, almost no free float, and quotes an Aqua order book.
///
/// @dev The settlement window. `SwapVM._transferOut` calls the maker's `preTransferOut` hook, then reaches
///      `AQUA.pull`, which is a `safeTransferFrom` out of this contract. The hook is the last maker controlled
///      point before that pull, in both transfer orders the router supports, and the only thing that can run
///      in between is a callback the taker itself must request: `SwapVM.sol:316-319` fires
///      `preTransferOutCallback` on the taker when `hasPreTransferOutCallback` is set. That callback is the
///      taker's own code, so it changes nothing about what this vault must verify, and it is exactly why the
///      guards below check realised balances rather than trusting an ordering.
///
/// @dev Trust model. The withdrawal calldata is supplied by the taker, per fill, because it is built by the
///      Uniswap LP API against live chain state and cannot be baked into an immutable order. The vault does
///      not trust it. It pins the callee, pins the selector, and verifies the outcome against the amount the
///      VM computed, which the hook receives as a parameter, and against the value the position actually
///      released, which it prices on chain. A taker can therefore choose how to unwind but never whether the
///      maker ends up short, and never where the released collateral lands.
contract BebecitaVault is IMakerHooks, IHookStats, IERC165 {
    using SafeERC20 for IERC20;

    /// @dev Only the router may invoke maker hooks.
    error UnauthorizedCaller(address caller);
    /// @dev Only the owner may operate the vault.
    error UnauthorizedOwner(address caller);
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
    /// @dev The unwind released more value than it delivered to this vault: the rest was routed elsewhere.
    error UnwindValueDiverted(uint256 releasedValue, uint256 retainedValue, uint256 requiredValue);
    /// @dev Payload shorter than a selector.
    error PayloadTooShort();
    /// @dev The position manager did not answer with a position liquidity.
    error PositionLiquidityUnavailable(address positionManager, uint256 tokenId);
    /// @dev The position manager did not answer with a pool key and a packed position info word.
    error PositionInfoUnavailable(address positionManager, uint256 tokenId);
    /// @dev The pool key the position manager returned does not hash to the pool id packed beside it.
    error PositionInfoInconsistent(bytes32 poolId, uint256 info);
    /// @dev The state view did not answer with a slot0, or the pool is not initialised.
    error PoolPriceUnavailable(address stateView, bytes32 poolId);
    /// @dev The `PoolKey` argument is not the pool backing this position. URC-3 conformance requires the
    ///      accessors to speak for a named pool, so answering for a different one would be a wrong answer.
    error UnexpectedPool(bytes32 expected, bytes32 provided);
    /// @dev The fill is not between the two currencies of the pool backing the position.
    error UnexpectedPoolTokens(address tokenIn, address tokenOut, address currency0, address currency1);
    /// @dev A haircut at or above one hundred percent leaves nothing to quote against.
    error HaircutOutOfRange(uint16 haircutBps);

    event Shipped(bytes32 indexed strategyHash, address indexed app);
    event Unwound(bytes32 indexed orderHash, address indexed token, uint256 released, uint256 required);
    event Redeposited(bytes32 indexed orderHash, uint256 liquidityBefore, uint256 liquidityAfter);

    /// @notice Official Aqua protocol.
    IAqua public immutable AQUA;
    /// @notice Uniswap v4 PositionManager holding the inventory.
    address public immutable POSITION_MANAGER;
    /// @notice Uniswap v4 StateView, the read side of the PoolManager.
    /// @dev The PoolManager keeps `slot0` in transient-adjacent packed storage with no public getter, and
    ///      StateView is the periphery contract Uniswap deploys to read it. The vault needs the live price to
    ///      value the liquidity a withdrawal removed, so this address is as load bearing as the manager.
    address public immutable STATE_VIEW;
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

    /// @notice Safety margin, in basis points. Applied to the effective liquidity report, and reused as the
    ///         tolerance of the conservation guard.
    uint16 public haircutBps;

    /// @notice tokenOut units released per unit of position liquidity, scaled by 1e18.
    /// @dev A maker parameter, compiled into the `0x92` arguments so the instruction can price without doing
    ///      tick math in a `view`. It is exact only at parity inside a symmetric range. The guards and the
    ///      URC-3 report no longer use it: they read the pool and convert liquidity to both tokens properly.
    uint128 public unitsPerLiquidityE18;

    /// @dev `getPositionLiquidity(uint256)` on the v4 PositionManager.
    bytes4 private constant _GET_POSITION_LIQUIDITY = 0x1efeed33;
    /// @dev `getPoolAndPositionInfo(uint256)` on the v4 PositionManager, returning `(PoolKey, uint256 info)`.
    bytes4 private constant _GET_POOL_AND_POSITION_INFO = 0x7ba03aad;
    /// @dev `getSlot0(bytes32)` on the v4 StateView.
    bytes4 private constant _GET_SLOT0 = 0xc815641c;
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
        address stateView,
        uint256 tokenId,
        address owner_,
        uint8 maxUnwindPct_,
        uint16 haircutBps_,
        uint128 unitsPerLiquidityE18_
    ) {
        require(haircutBps_ < _BPS, HaircutOutOfRange(haircutBps_));
        AQUA = aqua;
        ROUTER = router;
        POSITION_MANAGER = positionManager;
        STATE_VIEW = stateView;
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
        require(haircutBps_ < _BPS, HaircutOutOfRange(haircutBps_));
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
    /// @dev The funding hook. Runs before `AQUA.pull` moves `amountOut` out of this vault.
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

        // Read the pool before handing control to the payload. Every read on this path is strict: a hook that
        // cannot see the position cannot judge what happened to it, so it reverts rather than failing open.
        (PoolKey memory key, int24 tickLower, int24 tickUpper, uint160 sqrtPriceX96) = _positionState();
        uint256 liquidityBefore = _positionLiquidity(true);

        _callPositionManager(takerData, 0);

        uint256 outAfter = IERC20(tokenOut).balanceOf(address(this));
        uint256 inAfter = IERC20(tokenIn).balanceOf(address(this));
        uint256 liquidityAfter = _positionLiquidity(true);

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

        // Guard 5: everything the unwind released must land here.
        //
        // Guards 1 to 3 bound how much of the position may go and how little may come back, and none of them
        // bounds where the released tokens went. A real `modifyLiquidities` payload composes v4 Actions
        // freely, so `DECREASE_LIQUIDITY` on the token id followed by `TAKE` with arbitrary recipients lets a
        // taker unwind the whole cap, route exactly `amountOut` here and keep the remainder of both tokens:
        // guard 1 is met exactly, guard 2 holds with equality because the released tokenIn never arrives, and
        // guard 3 caps liquidity rather than value. Repeated with dust fills that drains the position at
        // `maxUnwindPct` a time.
        //
        // So the liquidity actually removed is priced into both tokens at the live pool price, and the
        // vault's combined gain has to cover it. The tolerance is `haircutBps` and not a second knob: it is
        // already the maker's own statement of how much slack it accepts between what the position is worth
        // and what it will count on, and one number that means one thing is worth more than two that drift.
        if (removed != 0) {
            (uint256 released0, uint256 released1) = LiquidityAmounts.getAmountsForLiquidity(
                sqrtPriceX96,
                TickMath.getSqrtPriceAtTick(tickLower),
                TickMath.getSqrtPriceAtTick(tickUpper),
                removed
            );

            bool outIsCurrency0 = _poolSide(key, tokenIn, tokenOut);
            uint256 gained0 = outIsCurrency0 ? outAfter - outBefore : inAfter - inBefore;
            uint256 gained1 = outIsCurrency0 ? inAfter - inBefore : outAfter - outBefore;

            uint256 releasedValue = LiquidityAmounts.valueInToken1(released0, released1, sqrtPriceX96);
            uint256 retainedValue = LiquidityAmounts.valueInToken1(gained0, gained1, sqrtPriceX96);
            uint256 requiredValue = Math.mulDiv(releasedValue, _BPS - haircutBps, _BPS);

            require(retainedValue >= requiredValue, UnwindValueDiverted(releasedValue, retainedValue, requiredValue));
        }

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

        uint256 liquidityBefore = _positionLiquidity(true);
        _callPositionManager(takerData, 0);
        uint256 liquidityAfter = _positionLiquidity(true);

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
    /// @dev Reserves are the vault's free float plus the real per token content of the position, read from the
    ///      pool rather than derived from a single scalar. A concentrated position is not two equal halves:
    ///      below its range it is all token0, above it all token1, and inside it splits by where the price
    ///      sits. Reporting the same number on both sides was only ever true at parity.
    function getReserves(PoolKey calldata key) external view override returns (uint256 token0, uint256 token1) {
        (uint256 deployed0, uint256 deployed1) = deployedAmounts(key);
        token0 = IERC20(key.currency0).balanceOf(address(this)) + deployed0;
        token1 = IERC20(key.currency1).balanceOf(address(this)) + deployed1;
    }

    /// @inheritdoc IHookStats
    /// @dev Effective liquidity is what one fill could actually reach: free float plus the capped, haircut
    ///      share of the position, per token. Cap and haircut are the same monotone factor on both sides, so
    ///      the standard's invariant `getEffectiveLiquidity <= getReserves` holds per token by construction
    ///      rather than by coincidence.
    function getEffectiveLiquidity(PoolKey calldata key)
        external
        view
        override
        returns (uint256 token0, uint256 token1)
    {
        (uint256 reachable0, uint256 reachable1) = reachableAmounts(key);
        token0 = IERC20(key.currency0).balanceOf(address(this)) + reachable0;
        token1 = IERC20(key.currency1).balanceOf(address(this)) + reachable1;
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

    /// @notice What the whole position holds right now, per token, at the live pool price.
    /// @dev Reverts unless `key` is the pool backing the position. URC-3's conformance list requires the
    ///      accessors to answer for the pool they are asked about, and a report about a different pool would
    ///      be a wrong answer rather than a missing one.
    function deployedAmounts(PoolKey calldata key) public view returns (uint256 amount0, uint256 amount1) {
        (PoolKey memory backing, int24 tickLower, int24 tickUpper, uint160 sqrtPriceX96) = _positionState();
        _requireSamePool(key, backing);

        return LiquidityAmounts.getAmountsForLiquidity(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            _positionLiquidity(false)
        );
    }

    /// @notice The share of the position a single fill may lean on, per token, after cap and haircut.
    function reachableAmounts(PoolKey calldata key) public view returns (uint256 amount0, uint256 amount1) {
        (uint256 deployed0, uint256 deployed1) = deployedAmounts(key);
        amount0 = _capAndHaircut(deployed0);
        amount1 = _capAndHaircut(deployed1);
    }

    /// @notice The share of the position a single fill may lean on, in the instruction's own scalar terms.
    /// @dev This is the figure instruction `0x92` computes from `unitsPerLiquidityE18`, kept so the dashboard
    ///      and the tests read the same number the VM clamps to. It is a maker parameter and it drifts from
    ///      the position as the pool moves off parity; `reachableAmounts` is the on chain truth, and the fix
    ///      when the two separate is to re-ship with the measured factor and `setRiskParams` to match.
    function reachableFromPosition() public view returns (uint256) {
        return _capAndHaircut(Math.mulDiv(_positionLiquidity(false), unitsPerLiquidityE18, _WAD));
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
    /// @param strict Revert rather than report zero when the read fails. Set on the hook paths, where a read
    ///        that fails open would turn guard 3 into a no-op and guard 5 into a skipped branch; unset in the
    ///        view reporting, where a burnt or unreadable position should read as no collateral rather than
    ///        break a dashboard.
    function _positionLiquidity(bool strict) private view returns (uint256) {
        (bool success, bytes memory result) =
            POSITION_MANAGER.staticcall(abi.encodeWithSelector(_GET_POSITION_LIQUIDITY, TOKEN_ID));
        if (!success || result.length != 32) {
            require(!strict, PositionLiquidityUnavailable(POSITION_MANAGER, TOKEN_ID));
            return 0;
        }
        return abi.decode(result, (uint256));
    }

    /// @dev The pool behind the position, its tick bounds and its live price, all read on chain.
    ///
    ///      Both reads are hardened the way `_positionLiquidity` and `Fee._dynamicProtocolFeeAmountInXD` are:
    ///      the return length is pinned and a short answer is a revert, so a contract that happens to have the
    ///      selector cannot feed this a truncated word. Neither read has a fail soft mode, because there is no
    ///      safe default price and no safe default range.
    function _positionState()
        private
        view
        returns (PoolKey memory key, int24 tickLower, int24 tickUpper, uint160 sqrtPriceX96)
    {
        (bool infoOk, bytes memory info) =
            POSITION_MANAGER.staticcall(abi.encodeWithSelector(_GET_POOL_AND_POSITION_INFO, TOKEN_ID));
        require(infoOk && info.length == 192, PositionInfoUnavailable(POSITION_MANAGER, TOKEN_ID));

        // `PoolKey` is a static struct, so it is five inline words followed by the packed info word.
        (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks, uint256 packed) =
            abi.decode(info, (address, address, uint24, int24, address, uint256));
        key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: hooks
        });

        // `PositionInfo` packs, from the least significant bit: 8 bits of subscriber flag, 24 bits of
        // tickLower, 24 bits of tickUpper, then the top 200 bits of the pool id.
        tickLower = int24(uint24(packed >> 8));
        tickUpper = int24(uint24(packed >> 32));

        bytes32 poolId = keccak256(abi.encode(key));

        // The truncated id travels beside the key, so the two can be checked against each other. That turns a
        // wrong assumption about this bit layout into a named revert instead of a silently wrong tick range.
        require(uint256(poolId) >> 56 == packed >> 56, PositionInfoInconsistent(poolId, packed));

        (bool slotOk, bytes memory slot0) =
            STATE_VIEW.staticcall(abi.encodeWithSelector(_GET_SLOT0, poolId));
        require(slotOk && slot0.length == 128, PoolPriceUnavailable(STATE_VIEW, poolId));

        (sqrtPriceX96,,,) = abi.decode(slot0, (uint160, int24, uint24, uint24));
        require(sqrtPriceX96 != 0, PoolPriceUnavailable(STATE_VIEW, poolId));
    }

    /// @dev URC-3 accessors take a `PoolKey`. It has to be the one backing this position or the answer is
    ///      about something else.
    function _requireSamePool(PoolKey calldata provided, PoolKey memory backing) private pure {
        bytes32 providedId = keccak256(abi.encode(provided));
        bytes32 backingId = keccak256(abi.encode(backing));
        require(providedId == backingId, UnexpectedPool(backingId, providedId));
    }

    /// @dev Which side of the pool the fill pays out on, and a check that the fill is on this pool at all.
    function _poolSide(PoolKey memory key, address tokenIn, address tokenOut)
        private
        pure
        returns (bool outIsCurrency0)
    {
        if (tokenOut == key.currency0 && tokenIn == key.currency1) return true;
        if (tokenOut == key.currency1 && tokenIn == key.currency0) return false;
        revert UnexpectedPoolTokens(tokenIn, tokenOut, key.currency0, key.currency1);
    }

    /// @dev The per fill cap, then the haircut, in that order.
    function _capAndHaircut(uint256 amount) private view returns (uint256) {
        return Math.mulDiv(Math.mulDiv(amount, maxUnwindPct, 100), _BPS - haircutBps, _BPS);
    }

    /// @notice Accept the position NFT.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}
