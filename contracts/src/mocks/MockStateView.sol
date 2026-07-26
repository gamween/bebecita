// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MockStateView
/// @notice Stands in for the Uniswap v4 StateView in unit tests.
/// @dev Only `getSlot0(bytes32)` matters to the vault, and only its first word: the live `sqrtPriceX96` of the
///      pool backing the position. Selector and return shape match the real deployment on Ethereum Sepolia at
///      0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c, four words, `(uint160, int24, uint24, uint24)`.
contract MockStateView {
    mapping(bytes32 poolId => uint160 sqrtPriceX96) public priceOf;
    mapping(bytes32 poolId => int24 tick) public tickOf;

    function setPrice(bytes32 poolId, uint160 sqrtPriceX96, int24 tick) external {
        priceOf[poolId] = sqrtPriceX96;
        tickOf[poolId] = tick;
    }

    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)
    {
        return (priceOf[poolId], tickOf[poolId], 0, 3000);
    }
}
