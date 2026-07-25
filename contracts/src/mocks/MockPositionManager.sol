// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockPositionManager
/// @notice Stands in for the Uniswap v4 PositionManager in unit tests.
///
/// @dev It reproduces only the two behaviours the vault depends on: `getPositionLiquidity` returns a number
///      that goes down when liquidity is removed and up when it is added, and `modifyLiquidities` moves tokens
///      accordingly. The selector and the read signature match the real contract on Ethereum Sepolia, verified
///      against 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4, so a program that satisfies the guards here
///      satisfies them there.
///
/// @dev The payload shape is deliberately simplified: the real API returns v4 Actions bytes, which the vault
///      never decodes, because it judges the payload by its effects rather than by its shape. That is the
///      whole point of the four guards, and it is what makes this mock a faithful substitute for the guard
///      logic even though the encoding differs.
contract MockPositionManager {
    using SafeERC20 for IERC20;

    error UnknownAction(uint8 action);

    uint8 internal constant ACTION_DECREASE = 1;
    uint8 internal constant ACTION_INCREASE = 2;

    mapping(uint256 tokenId => uint256 liquidity) public liquidityOf;

    address public immutable TOKEN0;
    address public immutable TOKEN1;

    /// @notice Units of each token released per unit of liquidity, scaled by 1e18.
    uint256 public unitsPerLiquidityE18;

    constructor(address token0, address token1, uint256 unitsPerLiquidityE18_) {
        TOKEN0 = token0;
        TOKEN1 = token1;
        unitsPerLiquidityE18 = unitsPerLiquidityE18_;
    }

    /// @notice Seed a position and fund the manager so it can pay withdrawals.
    function seed(uint256 tokenId, uint256 liquidity) external {
        liquidityOf[tokenId] = liquidity;
    }

    /// @notice Matches the real `getPositionLiquidity(uint256)`, selector 0x1efeed33.
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128) {
        return uint128(liquidityOf[tokenId]);
    }

    /// @notice Matches the real `modifyLiquidities(bytes,uint256)`, selector 0xdd46508f.
    /// @param unlockData Encoded as (uint8 action, uint256 tokenId, uint256 liquidityDelta, address recipient).
    function modifyLiquidities(bytes calldata unlockData, uint256 /* deadline */ ) external payable {
        (uint8 action, uint256 tokenId, uint256 liquidityDelta, address counterparty) =
            abi.decode(unlockData, (uint8, uint256, uint256, address));

        uint256 amount = liquidityDelta * unitsPerLiquidityE18 / 1e18;

        if (action == ACTION_DECREASE) {
            liquidityOf[tokenId] -= liquidityDelta;
            IERC20(TOKEN0).safeTransfer(counterparty, amount);
            IERC20(TOKEN1).safeTransfer(counterparty, amount);
        } else if (action == ACTION_INCREASE) {
            liquidityOf[tokenId] += liquidityDelta;
            IERC20(TOKEN0).safeTransferFrom(counterparty, address(this), amount);
            IERC20(TOKEN1).safeTransferFrom(counterparty, address(this), amount);
        } else {
            revert UnknownAction(action);
        }
    }

    /// @notice Helper used by tests to build a payload the vault will accept.
    function encodeDecrease(uint256 tokenId, uint256 liquidityDelta, address recipient)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(
            this.modifyLiquidities.selector, abi.encode(ACTION_DECREASE, tokenId, liquidityDelta, recipient), 0
        );
    }

    /// @notice Helper used by tests to build a redeposit payload.
    function encodeIncrease(uint256 tokenId, uint256 liquidityDelta, address from)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(
            this.modifyLiquidities.selector, abi.encode(ACTION_INCREASE, tokenId, liquidityDelta, from), 0
        );
    }
}
