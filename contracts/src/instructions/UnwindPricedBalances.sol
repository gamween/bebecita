// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { Context } from "@1inch/swap-vm/src/libs/VM.sol";

/// @title UnwindPricedBalancesArgsBuilder
/// @notice Encodes and decodes the arguments of `_unwindPricedBalanceOut1D`.
/// @dev Parameter ranges are constrained here, as required by swap-vm docs/PROGRAMS.md:
///      "Constrain dangerous parameter ranges in instruction builders to prevent unsafe program construction."
library UnwindPricedBalancesArgsBuilder {
    /// @dev Total encoded length: 20 + 32 + 2 + 1 + 16 = 71 bytes.
    uint256 internal constant ARGS_LENGTH = 71;

    uint256 internal constant BPS = 10_000;

    /// @dev Haircut must leave something to quote against.
    error HaircutTooLarge(uint16 haircutBps);
    /// @dev A per-fill unwind share outside 1..100 cannot be expressed by the Uniswap LP API,
    ///      whose `liquidityPercentageToDecrease` is an integer percentage in [1, 100].
    error UnwindShareOutOfRange(uint8 maxUnwindPct);
    /// @dev A zero conversion factor would make the deployed leg worth nothing.
    error ZeroUnitsPerLiquidity();
    /// @dev Args length mismatch on parse.
    error InvalidArgsLength(uint256 length);

    /// @notice Build the argument blob for the instruction.
    /// @param positionManager Contract exposing `getPositionLiquidity(uint256)`.
    /// @param tokenId Identifier of the liquidity position backing this strategy.
    /// @param haircutBps Safety margin applied to the deployed leg, in basis points.
    /// @param maxUnwindPct Largest share of the position a single fill may unwind, in percent.
    /// @param unitsPerLiquidityE18 tokenOut units released per unit of position liquidity, scaled by 1e18.
    function build(
        address positionManager,
        uint256 tokenId,
        uint16 haircutBps,
        uint8 maxUnwindPct,
        uint128 unitsPerLiquidityE18
    ) internal pure returns (bytes memory) {
        require(haircutBps < BPS, HaircutTooLarge(haircutBps));
        require(maxUnwindPct >= 1 && maxUnwindPct <= 100, UnwindShareOutOfRange(maxUnwindPct));
        require(unitsPerLiquidityE18 > 0, ZeroUnitsPerLiquidity());
        return abi.encodePacked(positionManager, tokenId, haircutBps, maxUnwindPct, unitsPerLiquidityE18);
    }

    /// @notice Decode the argument blob.
    function parse(bytes calldata args)
        internal
        pure
        returns (
            address positionManager,
            uint256 tokenId,
            uint16 haircutBps,
            uint8 maxUnwindPct,
            uint128 unitsPerLiquidityE18
        )
    {
        require(args.length == ARGS_LENGTH, InvalidArgsLength(args.length));
        positionManager = address(bytes20(args));
        tokenId = uint256(bytes32(args[20:52]));
        haircutBps = uint16(bytes2(args[52:54]));
        maxUnwindPct = uint8(bytes1(args[54:55]));
        unitsPerLiquidityE18 = uint128(bytes16(args[55:71]));
    }
}

/// @title UnwindPricedBalances
/// @notice Prices an Aqua strategy against collateral that is deployed outside the maker's wallet.
///
/// @dev Why this instruction exists.
///      Aqua quotes against the virtual balance a maker shipped, and never checks that the real tokens are
///      there: `Aqua.ship` performs no solvency check at all, and `Aqua.pull` decrements the virtual balance
///      and only then calls `safeTransferFrom` on the maker's wallet. A maker whose inventory lives in a
///      Uniswap liquidity position therefore quotes depth it does not hold as free float, and every fill
///      reverts at the very last instruction. This instruction closes that gap by recomposing the quotable
///      balance from what is genuinely reachable within the settlement transaction.
///
/// @dev Placement. It MUST run before the swap-curve instruction. The guard mirrors `Decay._decayXD` and
///      `MinRate`: both amount registers must still be zero, which holds in exact-in and exact-out alike.
///
/// @dev QUOTE/SWAP DIVERGENCE: none. This instruction is `view`. It writes no storage, so `isStaticContext`
///      is irrelevant to it and `quote()` and `swap()` return identical amounts by construction. This is the
///      only invariant of the SwapVM core suite that cannot be skipped, and this instruction satisfies it
///      structurally rather than by discipline.
///
/// @dev The instruction only ever lowers `balanceOut`. It never raises it, and it never touches `balanceIn`:
///      on the constant-product curves wired into the Aqua opcode table, lowering `balanceIn` would raise the
///      amount paid out, which is the exact opposite of the intent.
contract UnwindPricedBalances {
    using Calldata for bytes;

    /// @dev The external liquidity source did not answer with a single word.
    error PositionLiquidityCallFailed(address positionManager, uint256 tokenId);
    /// @dev Instruction was placed after the swap amounts were computed.
    error UnwindShouldBeCalledBeforeSwapAmountsComputation(uint256 amountIn, uint256 amountOut);

    /// @dev `IPositionManager.getPositionLiquidity(uint256)`, verified against the Uniswap v4
    ///      PositionManager deployed on Ethereum Sepolia at 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4.
    bytes4 private constant _GET_POSITION_LIQUIDITY = 0x1efeed33;

    uint256 private constant _BPS = 10_000;
    uint256 private constant _WAD = 1e18;

    /// @notice Recompose the quotable output balance from free float plus the reachable part of the position.
    /// @dev args.positionManager      | 20 bytes
    /// @dev args.tokenId              | 32 bytes
    /// @dev args.haircutBps           |  2 bytes
    /// @dev args.maxUnwindPct         |  1 byte
    /// @dev args.unitsPerLiquidityE18 | 16 bytes
    function _unwindPricedBalanceOut1D(Context memory ctx, bytes calldata args) internal view {
        require(
            ctx.swap.amountIn == 0 || ctx.swap.amountOut == 0,
            UnwindShouldBeCalledBeforeSwapAmountsComputation(ctx.swap.amountIn, ctx.swap.amountOut)
        );

        (
            address positionManager,
            uint256 tokenId,
            uint16 haircutBps,
            uint8 maxUnwindPct,
            uint128 unitsPerLiquidityE18
        ) = UnwindPricedBalancesArgsBuilder.parse(args);

        uint256 reachable = _reachableFromPosition(
            positionManager, tokenId, haircutBps, maxUnwindPct, unitsPerLiquidityE18
        );
        uint256 float = IERC20(ctx.query.tokenOut).balanceOf(ctx.query.maker);

        // Clamp, never assign: writing above the shipped Aqua balance would price a fill that
        // `Aqua.pull` cannot honour, and the underflow would revert after the whole program ran.
        ctx.swap.balanceOut = Math.min(ctx.swap.balanceOut, float + reachable);
    }

    /// @notice The part of the deployed position a single fill is allowed to rely on.
    /// @dev Read with a hardened staticcall: the return length is pinned, following the pattern used by
    ///      `Fee._dynamicProtocolFeeAmountInXD` against an untrusted provider.
    function _reachableFromPosition(
        address positionManager,
        uint256 tokenId,
        uint16 haircutBps,
        uint8 maxUnwindPct,
        uint128 unitsPerLiquidityE18
    ) internal view returns (uint256) {
        (bool success, bytes memory result) = positionManager.staticcall(
            abi.encodeWithSelector(_GET_POSITION_LIQUIDITY, tokenId)
        );
        require(success && result.length == 32, PositionLiquidityCallFailed(positionManager, tokenId));

        uint256 liquidity = abi.decode(result, (uint256));
        if (liquidity == 0) return 0;

        // Value the position conservatively. The exact amount a withdrawal releases depends on tick math the
        // instruction deliberately does not reproduce; the hook enforces the real figure after the fact by
        // checking the balance delta before the tokens leave the maker.
        uint256 deployed = Math.mulDiv(liquidity, unitsPerLiquidityE18, _WAD);

        // A single fill may only lean on the share the LP API can actually execute in one call.
        uint256 usable = Math.mulDiv(deployed, maxUnwindPct, 100);

        return Math.mulDiv(usable, _BPS - haircutBps, _BPS);
    }
}
