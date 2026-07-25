// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraits } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

/// @title Fill
/// @notice Sends one fill against the Bebecita book, with the two Uniswap payloads carried in the taker traits.
///
/// @dev Why the traits are built here and not in TypeScript. `TakerTraits` is a 22 byte header of ten 16 bit
///      slice indexes followed by a flag word, and every index is a running sum of the lengths of the slices
///      before it. Reproducing that arithmetic by hand in a second language means owning a second copy of it,
///      and the failure mode is silent: a header off by one byte does not fail to decode, it decodes a
///      different slice, the VM prices against garbage and the revert that surfaces is
///      `TakerTraitsAmountOutMustBeGreaterThanZero`, which points at the amount rather than at the header.
///      `TakerTraitsLib.build` is the sponsor's own builder and it is `internal pure`, so a script can call it
///      and a TypeScript process cannot. This script is therefore the seam: the solver sizes the fill and
///      fetches the calldata, this reads it back and does the encoding where the library lives.
///
/// @dev The input is `deployments/fill.local.json`, written by `solver/src/fill.ts` immediately before this
///      runs. It holds calldata the Uniswap API built against a block that has already passed, so it is
///      deliberately short lived and gitignored.
///
/// @dev Usage, normally through `yarn fill`:
///      forge script contracts/script/Fill.s.sol --rpc-url sepolia --broadcast --skip test
contract Fill is Script {
    string internal constant REQUEST = "deployments/fill.local.json";

    function run() external {
        string memory json = vm.readFile(REQUEST);

        address router = vm.parseJsonAddress(json, ".router");
        address taker = vm.parseJsonAddress(json, ".taker");
        address positionManager = vm.parseJsonAddress(json, ".positionManager");
        uint256 amount = _uint(json, ".amount");
        uint256 amountOutMin = _uint(json, ".amountOutMin");

        ISwapVM.Order memory order = ISwapVM.Order({
            maker: vm.parseJsonAddress(json, ".order.maker"),
            traits: MakerTraits.wrap(_uint(json, ".order.traits")),
            data: vm.parseJsonBytes(json, ".order.data")
        });

        bytes memory decreaseCalldata = vm.parseJsonBytes(json, ".decreaseCalldata");
        bytes memory increaseCalldata = vm.parseJsonBytes(json, ".increaseCalldata");

        require(decreaseCalldata.length > 4, "no /lp/decrease calldata, the fill would have nothing to unwind");
        require(increaseCalldata.length > 4, "no /lp/increase calldata, the inventory would stay idle");
        require(amountOutMin > 0, "amountOutMin must be set, a taker without slippage protection is a bug");

        bytes memory takerTraitsAndData = _buildTakerTraits(
            taker, amountOutMin, decreaseCalldata, increaseCalldata
        );

        console.log("router           ", router);
        console.log("taker            ", taker);
        console.log("amount in        ", amount);
        console.log("amount out min   ", amountOutMin);
        console.log("decrease calldata", decreaseCalldata.length);
        console.log("increase calldata", increaseCalldata.length);
        console.log("taker traits     ", takerTraitsAndData.length);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        require(vm.addr(deployerKey) == taker, "DEPLOYER_PRIVATE_KEY is not the taker named in the request");

        // The claim of this project, asserted rather than read off a trace: both Uniswap payloads reach the
        // position manager, once each, inside the one transaction that also settles the fill. A count of one
        // is stricter than a presence check, and it fails the script before anything is broadcast.
        vm.expectCall(positionManager, decreaseCalldata, 1);
        vm.expectCall(positionManager, increaseCalldata, 1);

        vm.startBroadcast(deployerKey);
        (uint256 amountIn, uint256 amountOut, bytes32 orderHash) =
            ISwapVM(router).swap(order, amount, takerTraitsAndData);
        vm.stopBroadcast();

        console.log("orderHash        ", vm.toString(orderHash));
        console.log("amountIn         ", amountIn);
        console.log("amountOut        ", amountOut);
    }

    /// @notice `TakerTraitsLib.build` for the one shape this project uses.
    ///
    /// @dev Three flags carry the whole design.
    ///
    ///      `isFirstTransferFromTaker` stays false. That selects the second transfer ordering in
    ///      `SwapVM.swap`, which runs `preTransferOut` and the Aqua pull first and `postTransferIn` last.
    ///      `postTransferIn` is then the only hook that runs after the taker's input has reached the maker,
    ///      which is what makes a two sided redeposit fundable, which is what keeps the position in range and
    ///      therefore earning. Flipping this bit moves the redeposit before the money arrives and silently
    ///      turns a two sided refund into a one sided one.
    ///
    ///      `useTransferFromAndAquaPush` is true, so the router pulls `tokenIn` from the taker and pushes it
    ///      into Aqua on the taker's behalf. The alternative expects the taker to have pushed beforehand.
    ///
    ///      `isExactIn` is true: the solver sizes the fill from an input amount and the VM computes the output.
    ///
    /// @dev The unwind goes in `preTransferOutHookData` because `preTransferOut` is the only point in SwapVM
    ///      guaranteed to run immediately before tokens leave the maker, and the redeposit goes in
    ///      `postTransferInHookData` for the ordering reason above. Both are executed by `BebecitaVault`,
    ///      which pins the callee and the selector and then judges them by their effects.
    function _buildTakerTraits(
        address taker,
        uint256 amountOutMin,
        bytes memory decreaseCalldata,
        bytes memory increaseCalldata
    ) internal pure returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: true,
                threshold: abi.encodePacked(amountOutMin),
                to: address(0),
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: increaseCalldata,
                preTransferOutHookData: decreaseCalldata,
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
    }

    /// @dev Amounts travel as decimal strings. A JSON number would go through a double on the way in and
    ///      quietly lose the low digits of an 18 decimal amount.
    function _uint(string memory json, string memory key) internal pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, key));
    }
}
