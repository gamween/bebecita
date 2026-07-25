// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";

import { Context } from "@1inch/swap-vm/src/libs/VM.sol";
import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";

import { BebecitaOpcodes } from "../opcodes/BebecitaOpcodes.sol";

/// @title BebecitaRouter
/// @notice A redeployed SwapVM router carrying one extra instruction.
/// @dev Mirrors `AquaSwapVMRouter` one for one: same bases, same constructor, same dispatch override.
///      It points at the official Aqua deployment, so liquidity, accounting and settlement all remain the
///      sponsor's contracts. Only the instruction table differs.
contract BebecitaRouter is Simulator, SwapVM, BebecitaOpcodes {
    /// @param aqua Official Aqua protocol address.
    /// @param weth WETH address used for native payment paths.
    /// @param owner Address allowed to rescue stuck funds.
    /// @param name EIP-712 domain name.
    /// @param version EIP-712 domain version.
    constructor(address aqua, address weth, address owner, string memory name, string memory version)
        SwapVM(aqua, weth, owner, name, version)
        BebecitaOpcodes(aqua)
    {}

    /// @dev Dispatches an opcode to its handler for VM execution.
    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        _runOpcode(ctx, opcode, args);
    }
}
