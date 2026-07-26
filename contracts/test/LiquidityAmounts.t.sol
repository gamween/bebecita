// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { LiquidityAmounts, TickMath } from "../src/libraries/LiquidityAmounts.sol";

/// @notice External surface for the library, so a revert happens at a lower call depth than the cheatcode.
/// @dev `internal` library calls are inlined into the test itself, and `vm.expectRevert` cannot see a revert
///      that never crosses a call boundary. This wrapper exists for that and nothing else.
contract LiquidityAmountsHarness {
    function amountsFor(uint160 sqrtPriceX96, uint160 lower, uint160 upper, uint256 liquidity)
        external
        pure
        returns (uint256, uint256)
    {
        return LiquidityAmounts.getAmountsForLiquidity(sqrtPriceX96, lower, upper, liquidity);
    }

    function sqrtPriceAtTick(int24 tick) external pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(tick);
    }
}

/// @title LiquidityAmountsTest
/// @notice The conversion the vault's conservation guard rests on, checked against numbers computed by hand.
///
/// @dev The guard is only as good as this library. If it overstates what a withdrawal released, an honest
///      fill reverts and the demo dies; if it understates, the diversion it exists to stop gets through. So
///      the vectors here are chosen to be readable rather than generated: a range of exactly one to four, a
///      liquidity of exactly 1e18, and a price at, below and above that range, where the closed forms collapse
///      to fractions a reader can check without running anything.
contract LiquidityAmountsTest is Test {
    uint160 internal constant Q96 = 79228162514264337593543950336;

    /// @dev Price bounds 1 and 4, so their square roots are 1 and 2 and the arithmetic stays legible.
    uint160 internal constant SQRT_LOWER = Q96;
    uint160 internal constant SQRT_UPPER = 2 * Q96;

    uint256 internal constant L = 1e18;

    // ---------------------------------------------------------------------
    // The three cases
    // ---------------------------------------------------------------------

    /// @notice Below its range a position is entirely token0.
    /// @dev amount0 = L * (1/sqrtLower - 1/sqrtUpper) = 1e18 * (1 - 1/2) = 5e17. amount1 is nothing, because
    ///      the price has to come back into the range before any token1 is bought.
    function test_BelowRange_IsAllToken0() public pure {
        (uint256 amount0, uint256 amount1) =
            LiquidityAmounts.getAmountsForLiquidity(Q96 / 2, SQRT_LOWER, SQRT_UPPER, L);

        assertEq(amount0, 0.5e18, "token0 below the range");
        assertEq(amount1, 0, "a position below its range holds no token1");
    }

    /// @notice At the lower bound exactly, the position is still entirely token0.
    function test_AtTheLowerBound_IsAllToken0() public pure {
        (uint256 amount0, uint256 amount1) =
            LiquidityAmounts.getAmountsForLiquidity(SQRT_LOWER, SQRT_LOWER, SQRT_UPPER, L);

        assertEq(amount0, 0.5e18, "the boundary belongs to the below case");
        assertEq(amount1, 0, "no token1 at the lower bound");
    }

    /// @notice Above its range a position is entirely token1.
    /// @dev amount1 = L * (sqrtUpper - sqrtLower) = 1e18 * (2 - 1) = 1e18.
    function test_AboveRange_IsAllToken1() public pure {
        (uint256 amount0, uint256 amount1) =
            LiquidityAmounts.getAmountsForLiquidity(4 * Q96, SQRT_LOWER, SQRT_UPPER, L);

        assertEq(amount0, 0, "a position above its range holds no token0");
        assertEq(amount1, 1e18, "token1 above the range");
    }

    /// @notice At the upper bound exactly, the position is still entirely token1.
    function test_AtTheUpperBound_IsAllToken1() public pure {
        (uint256 amount0, uint256 amount1) =
            LiquidityAmounts.getAmountsForLiquidity(SQRT_UPPER, SQRT_LOWER, SQRT_UPPER, L);

        assertEq(amount0, 0, "no token0 at the upper bound");
        assertEq(amount1, 1e18, "the boundary belongs to the above case");
    }

    /// @notice Inside the range the position holds both, split by where the price sits.
    /// @dev At sqrtPrice 1.5, so a price of 2.25:
    ///      amount0 = L * (1/1.5 - 1/2) = 1e18 / 6, which floors to 166666666666666666;
    ///      amount1 = L * (1.5 - 1)     = 5e17.
    ///      This is the case the old single scalar could never express, because it reported the same number on
    ///      both sides whatever the price was doing.
    function test_InRange_SplitsBothWays() public pure {
        (uint256 amount0, uint256 amount1) =
            LiquidityAmounts.getAmountsForLiquidity(Q96 * 3 / 2, SQRT_LOWER, SQRT_UPPER, L);

        assertEq(amount0, 166666666666666666, "token0 inside the range");
        assertEq(amount1, 0.5e18, "token1 inside the range");
    }

    /// @notice Zero liquidity is worth nothing, which is the branch the guard skips.
    function test_ZeroLiquidityIsWorthNothing() public pure {
        (uint256 amount0, uint256 amount1) =
            LiquidityAmounts.getAmountsForLiquidity(Q96 * 3 / 2, SQRT_LOWER, SQRT_UPPER, 0);

        assertEq(amount0, 0, "zero liquidity, zero token0");
        assertEq(amount1, 0, "zero liquidity, zero token1");
    }

    /// @notice Crossed or zero bounds are rejected rather than silently producing a number.
    function test_RejectsAnInvalidRange() public {
        LiquidityAmountsHarness harness = new LiquidityAmountsHarness();

        vm.expectRevert(
            abi.encodeWithSelector(LiquidityAmounts.InvalidPriceRange.selector, SQRT_UPPER, SQRT_LOWER)
        );
        harness.amountsFor(Q96, SQRT_UPPER, SQRT_LOWER, L);

        vm.expectRevert(abi.encodeWithSelector(LiquidityAmounts.InvalidPriceRange.selector, uint160(0), SQRT_UPPER));
        harness.amountsFor(Q96, 0, SQRT_UPPER, L);
    }

    /// @notice Liquidity is a uint128 on chain, and anything larger is a decoding accident rather than a
    ///         position.
    function test_RejectsLiquidityAboveUint128() public {
        LiquidityAmountsHarness harness = new LiquidityAmountsHarness();

        uint256 tooBig = uint256(type(uint128).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(LiquidityAmounts.LiquidityOverflow.selector, tooBig));
        harness.amountsFor(Q96, SQRT_LOWER, SQRT_UPPER, tooBig);
    }

    // ---------------------------------------------------------------------
    // Valuing both sides as one number
    // ---------------------------------------------------------------------

    /// @notice At parity a token0 is a token1, so the value of a pair is their sum.
    function test_ValueInToken1_AtParity() public pure {
        assertEq(LiquidityAmounts.valueInToken1(3e18, 7e18, Q96), 10e18, "parity value is the sum");
    }

    /// @notice At a price of four, a token0 is worth four token1.
    function test_ValueInToken1_AwayFromParity() public pure {
        assertEq(LiquidityAmounts.valueInToken1(3e18, 7e18, 2 * Q96), 19e18, "3 * 4 + 7");
    }

    /// @notice The two step multiplication survives the top of the price range, where `sqrtPrice ** 2` would
    ///         not fit in a word.
    function test_ValueInToken1_SurvivesTheTopOfThePriceRange() public pure {
        uint256 value = LiquidityAmounts.valueInToken1(1, 0, TickMath.MAX_SQRT_PRICE);
        assertGt(value, 0, "the top of the range must still price");
    }

    // ---------------------------------------------------------------------
    // Ticks to prices
    // ---------------------------------------------------------------------

    /// @notice The three constants every v4 deployment publishes, so the vendored routine is checked against
    ///         numbers this repository did not choose.
    function test_TickMath_MatchesThePublishedConstants() public pure {
        assertEq(TickMath.getSqrtPriceAtTick(0), Q96, "tick zero is a price of one");
        assertEq(TickMath.getSqrtPriceAtTick(TickMath.MIN_TICK), TickMath.MIN_SQRT_PRICE, "MIN_SQRT_PRICE");
        assertEq(TickMath.getSqrtPriceAtTick(TickMath.MAX_TICK), TickMath.MAX_SQRT_PRICE, "MAX_SQRT_PRICE");
    }

    /// @notice Prices rise with ticks, and a tick and its mirror are reciprocals to within rounding.
    function test_TickMath_IsMonotonicAndSymmetric() public pure {
        assertGt(TickMath.getSqrtPriceAtTick(1), TickMath.getSqrtPriceAtTick(0), "not monotonic");
        assertLt(TickMath.getSqrtPriceAtTick(-1), TickMath.getSqrtPriceAtTick(0), "not monotonic");

        uint256 up = TickMath.getSqrtPriceAtTick(60);
        uint256 down = TickMath.getSqrtPriceAtTick(-60);
        assertApproxEqAbs(up * down / Q96, Q96, 1e6, "a tick and its mirror are not reciprocal");
    }

    /// @notice A tick outside the range v4 supports is a revert, not a wrapped number.
    function test_TickMath_RejectsAnImpossibleTick() public {
        LiquidityAmountsHarness harness = new LiquidityAmountsHarness();

        vm.expectRevert(abi.encodeWithSelector(TickMath.TickOutOfRange.selector, int24(887273)));
        harness.sqrtPriceAtTick(887273);
    }

    // ---------------------------------------------------------------------
    // The live position, as a vector
    // ---------------------------------------------------------------------

    /// @notice The library reproduces the conversion factor `yarn rebalance` measured on Sepolia.
    ///
    /// @dev This is the vector worth having, because nobody here picked it. After the rebalance recorded in
    ///      `deployments/sepolia.json` the pool sat at `sqrtPriceX96 = 71239837033853012859205292019` and the
    ///      solver measured 0.899173157285162373 bALPHA released per unit of liquidity. bALPHA is currency1 of
    ///      that pool, the position is full range, and one unit of liquidity inside a full range position is
    ///      worth `sqrt(price)` of token1. The library agrees to the wei with a figure that came off a receipt.
    function test_MatchesTheConversionFactorMeasuredOnSepolia() public pure {
        uint160 sqrtLive = 71239837033853012859205292019;
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(-887220);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(887220);

        (, uint256 amount1) = LiquidityAmounts.getAmountsForLiquidity(sqrtLive, sqrtLower, sqrtUpper, 1e18);

        assertApproxEqAbs(amount1, 899173157285162373, 2, "the measured conversion factor is not reproduced");
    }

    /// @notice At parity a full range unit of liquidity is one of each, which is why the maker's scalar of 1e18
    ///         looked honest for as long as the pool sat at tick zero.
    function test_FullRangeAtParityIsOneOfEach() public pure {
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(-887220);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(887220);

        (uint256 amount0, uint256 amount1) =
            LiquidityAmounts.getAmountsForLiquidity(Q96, sqrtLower, sqrtUpper, 1e18);

        assertApproxEqAbs(amount0, 1e18, 1e3, "full range token0 at parity");
        assertApproxEqAbs(amount1, 1e18, 1e3, "full range token1 at parity");
    }
}
