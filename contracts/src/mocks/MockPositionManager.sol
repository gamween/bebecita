// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { PoolKey } from "../interfaces/IHookStats.sol";

/// @title MockPositionManager
/// @notice Stands in for the Uniswap v4 PositionManager in unit tests.
///
/// @dev It reproduces the behaviours the vault depends on: `getPositionLiquidity` returns a number that goes
///      down when liquidity is removed and up when it is added, `getPoolAndPositionInfo` returns the pool key
///      and the packed `PositionInfo` word in the real bit layout, and `modifyLiquidities` moves tokens
///      accordingly. Every selector and every return shape matches the real contract on Ethereum Sepolia,
///      verified against 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4, so a program that satisfies the guards
///      here satisfies them there.
///
/// @dev A payload is a list of legs, and that is the one thing about this mock that is not a simplification.
///      The real `modifyLiquidities` takes v4 Actions and composes them freely: `DECREASE_LIQUIDITY` on a
///      token id, then `TAKE` or `TAKE_PAIR` naming any recipient it likes, then possibly an
///      `INCREASE_LIQUIDITY` settled from any payer. The previous version of this mock sent all proceeds of a
///      decrease to one address, which had to be the vault for the first guard to pass, so it could not
///      express the payload an attacker would actually send and the guard suite was being measured against a
///      strawman. Legs fix that: liquidity and tokens are conserved leg by leg, and the recipient of every
///      token is the caller's choice, which is exactly the freedom the real contract gives.
///
/// @dev Conservation is enforced across the whole payload rather than per leg: what the decreases release is
///      what the payload may route, and what the increases add is what it must pay for. A mock that let a
///      payload mint tokens would make any test written against it meaningless.
contract MockPositionManager {
    using SafeERC20 for IERC20;

    /// @dev A leg named neither a decrease nor an increase.
    error UnknownLegKind(uint8 kind);
    /// @dev The payload routed more or less than the decreases released.
    error ProceedsMustMatchRelease(uint256 routed, uint256 released);
    /// @dev The payload paid more or less than the increases require.
    error PaymentMustMatchDeposit(uint256 paid, uint256 required);

    /// @notice Liquidity leaves the position, tokens go to `counterparty`.
    uint8 public constant KIND_DECREASE = 1;
    /// @notice Liquidity joins the position, tokens come from `counterparty`.
    uint8 public constant KIND_INCREASE = 2;

    /// @param kind `KIND_DECREASE` or `KIND_INCREASE`.
    /// @param tokenId Position touched by this leg.
    /// @param liquidityDelta Liquidity added or removed. May be zero for a leg that only moves tokens.
    /// @param counterparty Recipient of a decrease leg, payer of an increase leg.
    /// @param amount0 Token0 routed to, or pulled from, the counterparty.
    /// @param amount1 Token1 routed to, or pulled from, the counterparty.
    struct Leg {
        uint8 kind;
        uint256 tokenId;
        uint256 liquidityDelta;
        address counterparty;
        uint256 amount0;
        uint256 amount1;
    }

    mapping(uint256 tokenId => uint256 liquidity) public liquidityOf;

    address public immutable TOKEN0;
    address public immutable TOKEN1;

    /// @notice Units of each token released per unit of liquidity, scaled by 1e18.
    uint256 public unitsPerLiquidityE18;

    /// @notice The pool the position sits in, and its tick bounds, reported the way the real contract does.
    PoolKey public poolKey;
    int24 public tickLower;
    int24 public tickUpper;

    constructor(address token0, address token1, uint256 unitsPerLiquidityE18_) {
        TOKEN0 = token0;
        TOKEN1 = token1;
        unitsPerLiquidityE18 = unitsPerLiquidityE18_;
    }

    /// @notice Seed a position and fund the manager so it can pay withdrawals.
    function seed(uint256 tokenId, uint256 liquidity) external {
        liquidityOf[tokenId] = liquidity;
    }

    /// @notice Declare the pool and the range every position here belongs to.
    function configurePool(PoolKey calldata key, int24 tickLower_, int24 tickUpper_) external {
        poolKey = key;
        tickLower = tickLower_;
        tickUpper = tickUpper_;
    }

    /// @notice Matches the real `getPositionLiquidity(uint256)`, selector 0x1efeed33.
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128) {
        return uint128(liquidityOf[tokenId]);
    }

    /// @notice Matches the real `getPoolAndPositionInfo(uint256)`, selector 0x7ba03aad.
    /// @dev `PositionInfo` packs, from the least significant bit: 8 bits of subscriber flag, 24 bits of
    ///      tickLower, 24 bits of tickUpper, then the top 200 bits of the pool id. Reproduced exactly, because
    ///      the vault decodes it and cross-checks the truncated id against `keccak256(abi.encode(key))`.
    function getPoolAndPositionInfo(uint256 /* tokenId */ ) external view returns (PoolKey memory, uint256) {
        uint256 info = (uint256(keccak256(abi.encode(poolKey))) >> 56) << 56;
        info |= uint256(uint24(tickUpper)) << 32;
        info |= uint256(uint24(tickLower)) << 8;
        return (poolKey, info);
    }

    /// @notice Matches the real `modifyLiquidities(bytes,uint256)`, selector 0xdd46508f.
    /// @param unlockData `abi.encode(Leg[])`.
    function modifyLiquidities(bytes calldata unlockData, uint256 /* deadline */ ) external payable {
        Leg[] memory legs = abi.decode(unlockData, (Leg[]));

        uint256 released;
        uint256 deposited;
        uint256 routed0;
        uint256 routed1;
        uint256 paid0;
        uint256 paid1;

        for (uint256 i = 0; i < legs.length; ++i) {
            Leg memory leg = legs[i];
            if (leg.kind == KIND_DECREASE) {
                liquidityOf[leg.tokenId] -= leg.liquidityDelta;
                released += leg.liquidityDelta;
                routed0 += leg.amount0;
                routed1 += leg.amount1;
            } else if (leg.kind == KIND_INCREASE) {
                liquidityOf[leg.tokenId] += leg.liquidityDelta;
                deposited += leg.liquidityDelta;
                paid0 += leg.amount0;
                paid1 += leg.amount1;
            } else {
                revert UnknownLegKind(leg.kind);
            }
        }

        uint256 owed = releaseFor(released);
        require(routed0 == owed, ProceedsMustMatchRelease(routed0, owed));
        require(routed1 == owed, ProceedsMustMatchRelease(routed1, owed));

        uint256 due = releaseFor(deposited);
        require(paid0 == due, PaymentMustMatchDeposit(paid0, due));
        require(paid1 == due, PaymentMustMatchDeposit(paid1, due));

        // Tokens move only once the whole payload has been shown to conserve them.
        for (uint256 i = 0; i < legs.length; ++i) {
            Leg memory leg = legs[i];
            if (leg.kind == KIND_DECREASE) {
                if (leg.amount0 != 0) IERC20(TOKEN0).safeTransfer(leg.counterparty, leg.amount0);
                if (leg.amount1 != 0) IERC20(TOKEN1).safeTransfer(leg.counterparty, leg.amount1);
            } else {
                if (leg.amount0 != 0) IERC20(TOKEN0).safeTransferFrom(leg.counterparty, address(this), leg.amount0);
                if (leg.amount1 != 0) IERC20(TOKEN1).safeTransferFrom(leg.counterparty, address(this), leg.amount1);
            }
        }
    }

    /// @notice What a given liquidity delta releases of each token.
    function releaseFor(uint256 liquidityDelta) public view returns (uint256) {
        return liquidityDelta * unitsPerLiquidityE18 / 1e18;
    }

    /// @notice The ordinary honest payload: one decrease, every token to one recipient.
    function encodeDecrease(uint256 tokenId, uint256 liquidityDelta, address recipient)
        external
        view
        returns (bytes memory)
    {
        uint256 amount = releaseFor(liquidityDelta);
        Leg[] memory legs = new Leg[](1);
        legs[0] = Leg(KIND_DECREASE, tokenId, liquidityDelta, recipient, amount, amount);
        return encodeLegs(legs);
    }

    /// @notice The ordinary honest redeposit: one increase, paid by one address.
    function encodeIncrease(uint256 tokenId, uint256 liquidityDelta, address from)
        external
        view
        returns (bytes memory)
    {
        uint256 amount = releaseFor(liquidityDelta);
        Leg[] memory legs = new Leg[](1);
        legs[0] = Leg(KIND_INCREASE, tokenId, liquidityDelta, from, amount, amount);
        return encodeLegs(legs);
    }

    /// @notice Any payload at all, which is what the real entry point accepts.
    function encodeLegs(Leg[] memory legs) public pure returns (bytes memory) {
        return abi.encodeWithSelector(this.modifyLiquidities.selector, abi.encode(legs), uint256(0));
    }



}
