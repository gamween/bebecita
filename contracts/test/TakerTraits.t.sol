// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { TakerTraits, TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

/// @title TakerTraitsPortTest
/// @notice Proves that the TypeScript taker traits builder emits exactly what the sponsor's library emits.
///
/// @dev This test is the reason the project has no backend. `TakerTraitsLib.build` is `internal pure`
///      Solidity, so it can only run inside a contract or a Foundry script, and that single fact used to force
///      every fill through a local process because `forge` is not available in a browser.
///      `solver/src/takerTraits.ts` ports the builder, the browser builds its own traits, the server is gone,
///      and what stands between that port and an incomprehensible failure at fill time is this file.
///
/// @dev The failure it exists to catch is silent. A slice index that is one byte off does not fail to decode,
///      it decodes a different slice: the unwind payload becomes the redeposit, or the threshold becomes the
///      first 32 bytes of a `modifyLiquidities` call, and the revert that reaches the taker is
///      `TakerTraitsAmountOutMustBeGreaterThanZero`, which names the amount rather than the header.
///
/// @dev The fixtures come from `yarn fixtures`, which writes each argument shape together with the bytes the
///      TypeScript produced for it. This reads them back, calls `TakerTraitsLib.build` on the same arguments
///      and asserts byte equality. `contracts/script/Fill.s.sol` is the same call in a script and stays in the
///      repository as the reference implementation this diff is taken against.
///
/// @dev Run with `forge test --match-path contracts/test/TakerTraits.t.sol`. Never bare `forge test`: `via_ir`
///      makes a full build cost close to four minutes.
contract TakerTraitsPortTest is Test {
    using TakerTraitsLib for TakerTraits;

    string internal constant FIXTURES = "contracts/test/fixtures/taker-traits.json";

    string internal fixtures;

    function setUp() public {
        fixtures = vm.readFile(FIXTURES);
    }

    /// @notice Every fixture, built by the sponsor's library, equals what the TypeScript port wrote down.
    function test_TypeScriptPortEqualsTheSponsorLibraryByteForByte() public view {
        uint256 count = vm.parseJsonUint(fixtures, ".count");
        assertGt(count, 0, "no fixtures, run yarn fixtures");

        for (uint256 i; i < count; ++i) {
            string memory at = string.concat(".cases[", vm.toString(i), "]");
            string memory name = vm.parseJsonString(fixtures, string.concat(at, ".name"));

            bytes memory built = TakerTraitsLib.build(_args(at));
            bytes memory expected = vm.parseJsonBytes(fixtures, string.concat(at, ".expected"));

            assertEq(built, expected, string.concat("taker traits diverge on case: ", name));
        }
    }

    /// @notice The header is 22 bytes on every shape, including the one where every flag is zero.
    /// @dev Twenty bytes of slice indexes and a two byte flag word. An empty flag word is still two bytes, and
    ///      a port that drops it produces a header the VM reads one slice short of everything.
    function test_HeaderIsAlwaysTwentyTwoBytesAheadOfTheSlices() public view {
        uint256 count = vm.parseJsonUint(fixtures, ".count");

        for (uint256 i; i < count; ++i) {
            string memory at = string.concat(".cases[", vm.toString(i), "]");
            bytes memory expected = vm.parseJsonBytes(fixtures, string.concat(at, ".expected"));
            assertGe(expected.length, 22, "a taker traits blob is at least its own header");
        }
    }

    /// @notice The bytes the browser sends decode back, through the sponsor's own readers, into what went in.
    ///
    /// @dev Byte equality above proves the port. This proves the shape means what the fill needs it to mean:
    ///      the `/lp/decrease` calldata comes back out of `preTransferOutHookData` and the `/lp/increase`
    ///      calldata out of `postTransferInHookData`, not the other way round, and the three flags that carry
    ///      the design survive the round trip. The slice readers used here are the same ones `SwapVM` calls.
    function test_TheLiveFillShapeRoundTripsThroughTheSponsorsOwnReaders() public view {
        uint256 index = vm.parseJsonUint(fixtures, ".liveFillIndex");
        string memory at = string.concat(".cases[", vm.toString(index), "]");

        bytes memory packed = vm.parseJsonBytes(fixtures, string.concat(at, ".expected"));
        Decoded memory decoded = this.decode(packed);

        assertEq(
            decoded.preTransferOutHookData,
            vm.parseJsonBytes(fixtures, string.concat(at, ".preTransferOutHookData")),
            "the unwind must decode out of the preTransferOut slice"
        );
        assertEq(
            decoded.postTransferInHookData,
            vm.parseJsonBytes(fixtures, string.concat(at, ".postTransferInHookData")),
            "the redeposit must decode out of the postTransferIn slice"
        );
        assertTrue(decoded.hasThreshold, "the live fill carries a slippage floor");
        assertEq(
            abi.encodePacked(decoded.thresholdAmount),
            vm.parseJsonBytes(fixtures, string.concat(at, ".threshold")),
            "the threshold must decode to the amountOutMin that was packed"
        );

        assertTrue(decoded.isExactIn, "the fill is exact in");
        assertTrue(decoded.isAToB, "the fill runs token0 to token1");
        assertTrue(decoded.useTransferFromAndAquaPush, "the router pulls the input from the taker");
        assertFalse(
            decoded.isFirstTransferFromTaker,
            "isFirstTransferFromTaker must stay false, it is what puts postTransferIn after the pull"
        );
        assertEq(decoded.preTransferInHookData.length, 0, "nothing belongs in the preTransferIn slice");
        assertEq(decoded.postTransferOutHookData.length, 0, "nothing belongs in the postTransferOut slice");
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    struct Decoded {
        bytes preTransferInHookData;
        bytes postTransferInHookData;
        bytes preTransferOutHookData;
        bytes postTransferOutHookData;
        bool hasThreshold;
        uint256 thresholdAmount;
        bool isExactIn;
        bool isAToB;
        bool isFirstTransferFromTaker;
        bool useTransferFromAndAquaPush;
    }

    /// @dev External so the blob arrives as `calldata`, which is what `TakerTraitsLib.parse` slices.
    function decode(bytes calldata packed) external pure returns (Decoded memory decoded) {
        (TakerTraits traits, bytes calldata tail) = TakerTraitsLib.parse(packed);
        (bool hasThreshold, uint256 thresholdAmount) = traits.threshold(tail);
        decoded = Decoded({
            preTransferInHookData: traits.preTransferInHookData(tail),
            postTransferInHookData: traits.postTransferInHookData(tail),
            preTransferOutHookData: traits.preTransferOutHookData(tail),
            postTransferOutHookData: traits.postTransferOutHookData(tail),
            hasThreshold: hasThreshold,
            thresholdAmount: thresholdAmount,
            isExactIn: traits.isExactIn(),
            isAToB: traits.isAToB(),
            isFirstTransferFromTaker: traits.isFirstTransferFromTaker(),
            useTransferFromAndAquaPush: traits.useTransferFromAndAquaPush()
        });
    }

    /// @dev One fixture case, read field by field. Reading the struct in one `vm.parseJson` would depend on
    ///      the alphabetical field ordering Foundry uses for tuples, which is a second thing to get wrong.
    function _args(string memory at) internal view returns (TakerTraitsLib.Args memory) {
        return TakerTraitsLib.Args({
            taker: vm.parseJsonAddress(fixtures, string.concat(at, ".taker")),
            isExactIn: _bool(at, ".isExactIn"),
            shouldUnwrapWeth: _bool(at, ".shouldUnwrapWeth"),
            isStrictThresholdAmount: _bool(at, ".isStrictThresholdAmount"),
            isFirstTransferFromTaker: _bool(at, ".isFirstTransferFromTaker"),
            useTransferFromAndAquaPush: _bool(at, ".useTransferFromAndAquaPush"),
            isAToB: _bool(at, ".isAToB"),
            threshold: _bytes(at, ".threshold"),
            to: vm.parseJsonAddress(fixtures, string.concat(at, ".to")),
            // A decimal string in the fixture file, because a JSON number would go through a double.
            deadline: uint40(vm.parseUint(vm.parseJsonString(fixtures, string.concat(at, ".deadline")))),
            hasPreTransferInCallback: _bool(at, ".hasPreTransferInCallback"),
            hasPreTransferOutCallback: _bool(at, ".hasPreTransferOutCallback"),
            preTransferInHookData: _bytes(at, ".preTransferInHookData"),
            postTransferInHookData: _bytes(at, ".postTransferInHookData"),
            preTransferOutHookData: _bytes(at, ".preTransferOutHookData"),
            postTransferOutHookData: _bytes(at, ".postTransferOutHookData"),
            preTransferInCallbackData: _bytes(at, ".preTransferInCallbackData"),
            preTransferOutCallbackData: _bytes(at, ".preTransferOutCallbackData"),
            instructionsArgs: _bytes(at, ".instructionsArgs"),
            signature: _bytes(at, ".signature")
        });
    }

    function _bool(string memory at, string memory key) internal view returns (bool) {
        return vm.parseJsonBool(fixtures, string.concat(at, key));
    }

    function _bytes(string memory at, string memory key) internal view returns (bytes memory) {
        return vm.parseJsonBytes(fixtures, string.concat(at, key));
    }
}
