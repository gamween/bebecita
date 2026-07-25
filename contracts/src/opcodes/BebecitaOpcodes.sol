// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "@1inch/swap-vm/src/libs/VM.sol";
import { Opcode } from "@1inch/swap-vm/src/libs/OpcodeList.sol";
import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";
import { Controls } from "@1inch/swap-vm/src/instructions/Controls.sol";

import { UnwindPricedBalances } from "../instructions/UnwindPricedBalances.sol";

/// @title BebecitaOpcodes
/// @notice The Aqua opcode table, extended with one new instruction and three that 1inch shipped but never wired.
///
/// @dev Extension style. This subclasses `AquaOpcodes` and overrides `_runOpcode` with a `super` fallthrough,
///      exactly as `AquaOpcodesDebug` does. Not one line of the sponsor's source is modified: the official
///      contracts are used as published, and only the SwapVM router is redeployed, which the 1inch track
///      allows explicitly.
///
/// @dev Slot discipline. `src/libs/OpcodeList.sol` is an opcode space banked by instruction family, and its
///      rule reads: "New instruction MUST take the next free `_Ix` slot of its family bank." Our instruction
///      adjusts a balance register, so it belongs to the 0x90-0xaf "Balances tuning" bank, whose next free
///      slot is `_92`. `BebecitaOpcodes.t.sol` asserts `uint256(Opcode._92) == 0x92` so that claim is machine
///      checked rather than asserted in prose.
///
/// @dev Rewired instructions. `AquaOpcodes` dispatches 19 opcodes where the full `Opcodes` table dispatches 46.
///      Three of them, `Stop`, `Revert` and `JumpIfDirection`, were added to `Controls.sol` on 2026-07-05 and
///      are unreachable from any Aqua program: a program using them reverts with `UnknownOpcode`. They are
///      wired back here because a program that cannot halt early cannot express a conditional strategy.
contract BebecitaOpcodes is AquaOpcodes, UnwindPricedBalances {
    /// @notice Opcode index of `_unwindPricedBalanceOut1D`, filling the reserved `_92` slot.
    uint256 public constant OPCODE_UNWIND_PRICED_BALANCE_OUT = 0x92;

    constructor(address aqua) AquaOpcodes(aqua) {}

    function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        if (opcode == OPCODE_UNWIND_PRICED_BALANCE_OUT) {
            UnwindPricedBalances._unwindPricedBalanceOut1D(ctx, args);
        } else if (opcode == uint256(Opcode.Stop)) {
            Controls._stop(ctx, args);
        } else if (opcode == uint256(Opcode.Revert)) {
            Controls._revert(ctx, args);
        } else if (opcode == uint256(Opcode.JumpIfDirection)) {
            Controls._jumpIfDirection(ctx, args);
        } else {
            super._runOpcode(ctx, opcode, args);
        }
    }
}
