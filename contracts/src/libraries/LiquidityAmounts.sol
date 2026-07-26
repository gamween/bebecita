// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title TickMath
/// @notice Tick to sqrt price conversion, the Uniswap v3/v4 core routine.
///
/// @dev Why this is vendored rather than imported. Neither v4-core nor v4-periphery is reachable through
///      this repository's dependency tree: the only Uniswap package `node_modules` carries is the permit2 SDK,
///      which is TypeScript. Pulling either package in for one pure function would add
///      a solidity dependency graph an order of magnitude larger than this project, so the one routine that is
///      genuinely needed is reproduced here, unmodified in behaviour, and checked against published constants
///      in `contracts/test/LiquidityAmounts.t.sol`.
///
/// @dev The algorithm. `sqrt(1.0001^tick)` is evaluated as a product over the set bits of `|tick|`, each factor
///      being `sqrt(1.0001^(2^i))` precomputed as a Q128.128 constant. Nineteen bits cover the whole tick
///      range. A negative tick is the reciprocal of the positive one, taken at the end. The Q128.128 result is
///      shifted down to Q96 and rounded up, which is the rounding the core contracts use.
library TickMath {
    /// @dev Tick outside the range v4 supports.
    error TickOutOfRange(int24 tick);

    /// @notice Widest tick the price format carries, and its mirror.
    int24 internal constant MAX_TICK = 887272;
    int24 internal constant MIN_TICK = -887272;

    /// @notice `getSqrtPriceAtTick(MIN_TICK)` and `getSqrtPriceAtTick(MAX_TICK)`, asserted in the tests.
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    /// @notice sqrt(1.0001^tick) in Q64.96 fixed point.
    function getSqrtPriceAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            require(absTick <= uint256(int256(MAX_TICK)), TickOutOfRange(tick));

            // Q128.128, seeded with either sqrt(1.0001^1) or 1 depending on the lowest bit.
            uint256 price =
                absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) price = (price * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) price = (price * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) price = (price * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) price = (price * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) price = (price * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) price = (price * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) price = (price * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) price = (price * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) price = (price * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) price = (price * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) price = (price * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) price = (price * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) price = (price * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) price = (price * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) price = (price * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) price = (price * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) price = (price * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) price = (price * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) price = (price * 0x48a170391f7dc42444e8fa2) >> 128;

            // A negative tick is the reciprocal. `type(uint256).max / price` is 2^256 / price to within one
            // unit, which is the Q128.128 reciprocal the core contracts use.
            if (tick > 0) price = type(uint256).max / price;

            // Q128.128 down to Q64.96, rounding up.
            sqrtPriceX96 = uint160((price >> 32) + (price % (1 << 32) == 0 ? 0 : 1));
        }
    }
}

/// @title LiquidityAmounts
/// @notice How much of each token a given amount of v4 liquidity is worth at a given price.
///
/// @dev This is the piece the vault was missing. `unitsPerLiquidityE18` is one scalar, so it can say what a
///      unit of liquidity is worth in one token and nothing about the split between the two. It is exact only
///      while the pool sits at parity inside a symmetric range, and it says nothing at all about which side of
///      the range the price is on. Without this conversion no guard can bound the value a withdrawal released,
///      and no URC-3 report can state per token reserves that are true rather than approximately true.
///
/// @dev The three cases are the standard ones and they are not an optimisation, they are the definition of a
///      concentrated position: below its range it holds only token0, above it only token1, and inside it holds
///      both in a ratio set by where the price sits.
///
/// @dev Rounding is down in every branch, deliberately. These amounts are compared against what the pool
///      actually paid out, and `PoolManager` itself rounds a removal down in its own favour, so rounding down
///      here keeps the expectation at or below the realised figure rather than one wei above it.
library LiquidityAmounts {
    /// @dev Bounds crossed, or a price of zero, which no pool can have.
    error InvalidPriceRange(uint160 sqrtPriceLowerX96, uint160 sqrtPriceUpperX96);
    /// @dev Liquidity above what a v4 position can hold.
    error LiquidityOverflow(uint256 liquidity);

    uint256 internal constant Q96 = 0x1000000000000000000000000;

    /// @notice The token0 and token1 amounts `liquidity` is worth at `sqrtPriceX96`.
    /// @param sqrtPriceX96 Live pool price, Q64.96.
    /// @param sqrtPriceLowerX96 Lower bound of the position, Q64.96.
    /// @param sqrtPriceUpperX96 Upper bound of the position, Q64.96.
    /// @param liquidity Amount of v4 liquidity to value.
    function getAmountsForLiquidity(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceLowerX96,
        uint160 sqrtPriceUpperX96,
        uint256 liquidity
    ) internal pure returns (uint256 amount0, uint256 amount1) {
        require(
            sqrtPriceLowerX96 != 0 && sqrtPriceLowerX96 < sqrtPriceUpperX96,
            InvalidPriceRange(sqrtPriceLowerX96, sqrtPriceUpperX96)
        );
        require(liquidity <= type(uint128).max, LiquidityOverflow(liquidity));
        if (liquidity == 0) return (0, 0);

        if (sqrtPriceX96 <= sqrtPriceLowerX96) {
            // Price below the range: the position is entirely token0.
            amount0 = _amount0(sqrtPriceLowerX96, sqrtPriceUpperX96, liquidity);
        } else if (sqrtPriceX96 < sqrtPriceUpperX96) {
            // Price inside the range: token0 above spot, token1 below it.
            amount0 = _amount0(sqrtPriceX96, sqrtPriceUpperX96, liquidity);
            amount1 = _amount1(sqrtPriceLowerX96, sqrtPriceX96, liquidity);
        } else {
            // Price above the range: the position is entirely token1.
            amount1 = _amount1(sqrtPriceLowerX96, sqrtPriceUpperX96, liquidity);
        }
    }

    /// @notice Value a pair of amounts in token1 terms at `sqrtPriceX96`, so two sides become one number.
    /// @dev `amount0 * price` is taken as two `mulDiv` steps by `sqrtPrice / 2^96` rather than one by
    ///      `price / 2^192`, because `sqrtPriceX96 ** 2` overflows a word at the top of the price range while
    ///      each half of the product does not.
    function valueInToken1(uint256 amount0, uint256 amount1, uint160 sqrtPriceX96)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(Math.mulDiv(amount0, sqrtPriceX96, Q96), sqrtPriceX96, Q96) + amount1;
    }

    /// @dev `L * (sqrtB - sqrtA) / (sqrtA * sqrtB)`, arranged so nothing overflows: the numerator is split
    ///      across two divisions instead of forming `sqrtA * sqrtB` first.
    function _amount0(uint160 sqrtA, uint160 sqrtB, uint256 liquidity) private pure returns (uint256) {
        return Math.mulDiv(liquidity << 96, sqrtB - sqrtA, sqrtB) / sqrtA;
    }

    /// @dev `L * (sqrtB - sqrtA)`, in Q64.96.
    function _amount1(uint160 sqrtA, uint160 sqrtB, uint256 liquidity) private pure returns (uint256) {
        return Math.mulDiv(liquidity, sqrtB - sqrtA, Q96);
    }
}
