// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { ITakerCallbacks } from "@1inch/swap-vm/src/interfaces/ITakerCallbacks.sol";

/// @title BebecitaTaker
/// @notice A taker that fills more than one order of the same maker without a block in between.
///
/// @dev Why this exists. Aqua keys a maker's virtual balances by order hash: `AQUA.safeBalances` is read per
///      order, so a maker running two strategies against one liquidity position has two independent promises
///      and no accounting that relates them. Instruction `0x92` is the thing that relates them, because it
///      recomputes the quotable balance from the position and the maker's float at execution time rather than
///      from what was shipped. That claim is only testable from a taker that can reach the router twice inside
///      one transaction, which is this contract and nothing else in the repository.
///
/// @dev Two shapes, and they are not the same experiment.
///
///      `fillAll` runs the fills back to back, each one starting after the previous has fully settled. This is
///      the shape a solver would batch, and what it demonstrates is that the second fill prices against the
///      position the first one left.
///
///      The callback runs the second fill inside the first, in the window `SwapVM.sol:316-319` opens between
///      the maker's `preTransferOut` hook and `AQUA.pull`. Only this shape needs the router's reentrancy guard
///      to be keyed by order hash rather than global, and only this shape reaches the maker while the first
///      fill's collateral is unwound but not yet paid out. `BebecitaVault` states that its guards check
///      realised balances rather than trusting an ordering; this is what executes that statement.
///
/// @dev This contract is a taker, so it is not trusted by anything and holds nothing at rest by design. It
///      keeps an owner for the two operations that move value it did not earn in a fill: the router allowance
///      the pull path needs, and the recovery of proceeds a fill delivered here.
contract BebecitaTaker is ITakerCallbacks {
    using SafeERC20 for IERC20;

    /// @dev Only the router may invoke taker callbacks.
    error UnauthorizedCaller(address caller);
    /// @dev Only the owner may operate the taker.
    error UnauthorizedOwner(address caller);
    /// @dev A callback this taker never requests, so an invocation of it means the traits are not ours.
    error UnrequestedCallback();

    /// @param order The maker's order, exactly as it was shipped to Aqua.
    /// @param amount Input amount on an exact-in fill, output amount on an exact-out one.
    /// @param takerTraitsAndData Packed taker traits, carrying the two Uniswap payloads and any callback data.
    struct Fill {
        ISwapVM.Order order;
        uint256 amount;
        bytes takerTraitsAndData;
    }

    /// @notice The SwapVM router this taker fills against.
    address public immutable ROUTER;
    /// @notice Operator of the taker.
    address public immutable OWNER;

    modifier onlyOwner() {
        require(msg.sender == OWNER, UnauthorizedOwner(msg.sender));
        _;
    }

    constructor(address router, address owner_) {
        ROUTER = router;
        OWNER = owner_;
    }

    /// @notice Allow the router to pull the input side of a fill.
    /// @dev With `IS_FIRST_TRANSFER_FROM_TAKER` unset and `useTransferFromAndAquaPush` set, the router pays the
    ///      maker by transferring from this contract and pushing into Aqua, so the allowance is what makes a
    ///      fill possible at all.
    function approveRouter(address token, uint256 amount) external onlyOwner {
        IERC20(token).forceApprove(ROUTER, amount);
    }

    /// @notice Recover what the fills delivered here.
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Fill several orders back to back in one transaction.
    /// @dev Nothing is netted between them and nothing is retried. Each fill either settles or reverts the
    ///      whole transaction, which is the only batching semantics a maker can reason about.
    function fillAll(Fill[] calldata fills) external returns (uint256[] memory amountsOut) {
        amountsOut = new uint256[](fills.length);
        for (uint256 i = 0; i < fills.length; ++i) {
            (, amountsOut[i],) = ISwapVM(ROUTER).swap(fills[i].order, fills[i].amount, fills[i].takerTraitsAndData);
        }
    }

    /// @inheritdoc ITakerCallbacks
    /// @dev The nesting point. The router hands back whatever the traits carried, so the inner fill travels in
    ///      the callback data instead of in storage: a taker that parks an order between two calls would have
    ///      to be trusted to clear it, and there is nothing here worth trusting.
    function preTransferOutCallback(
        address, /* maker */
        address, /* taker */
        address, /* tokenIn */
        address, /* tokenOut */
        uint256, /* amountIn */
        uint256, /* amountOut */
        bytes32, /* orderHash */
        bytes calldata takerData
    ) external override {
        require(msg.sender == ROUTER, UnauthorizedCaller(msg.sender));
        if (takerData.length == 0) return;

        Fill memory nested = abi.decode(takerData, (Fill));
        ISwapVM(ROUTER).swap(nested.order, nested.amount, nested.takerTraitsAndData);
    }

    /// @inheritdoc ITakerCallbacks
    /// @dev Never requested by any traits this contract fills with. Accepting it silently would let a caller
    ///      that builds its own traits run code here at a point this contract has not reasoned about.
    function preTransferInCallback(
        address,
        address,
        address,
        address,
        uint256,
        uint256,
        bytes32,
        bytes calldata
    ) external pure override {
        revert UnrequestedCallback();
    }
}
