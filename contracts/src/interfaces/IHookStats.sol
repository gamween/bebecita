// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal mirror of the Uniswap v4 `PoolKey`, redeclared here so the repository does not need to
///         vendor v4-core for two view functions. Field order and types match v4-core exactly.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @title IHookStats
/// @notice URC-3, "Hook TVL and Effective Liquidity Reporting", Uniswap Labs, created 2026-06-11, status Discussion.
///         Authors: Mark Toda, Daniel Gretzke, Alice Henshaw, Chris Cashwell.
///         https://gov.uniswap.org/t/urc-3-hook-tvl-and-effective-liquidity-reporting/26155
///
/// @dev The normative invariant of the standard is: for each token, `getEffectiveLiquidity` SHOULD be less
///      than or equal to `getReserves`. That is precisely what instruction 0x92 enforces inside the SwapVM
///      program, one instruction before settlement.
///
/// @dev URC-3 lists as motivating cases, verbatim: "Deploy liquidity in external protocols", "Use vaults or
///      lending markets", "Rehypothecate assets", "Maintain reserves outside the PoolManager". A Bebecita
///      vault does all four.
///
/// @dev Scope note, reported upstream in FEEDBACK.md: the standard is written for v4 hooks and its conformance
///      list makes `hook()` mandatory. A contract that merely holds reserves outside the PoolManager, as this
///      vault does, has no hook address to return. The semantics of the two accessors apply regardless.
interface IHookStats {
    /// @notice Total reserves attributable to the pool, whether or not they are immediately swappable.
    function getReserves(PoolKey calldata key) external view returns (uint256 token0, uint256 token1);

    /// @notice The subset of reserves that could be used to settle right now.
    function getEffectiveLiquidity(PoolKey calldata key) external view returns (uint256 token0, uint256 token1);

    /// @notice The hook this reporter speaks for.
    function hook() external view returns (address);
}
