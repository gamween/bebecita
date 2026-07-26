// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { BebecitaVault } from "../src/vault/BebecitaVault.sol";

/// @title DeployVault
/// @notice Redeploys the maker against a position that now exists.
///
/// @dev Why this script exists. `BebecitaVault.TOKEN_ID` is immutable, and the first deployment happened
///      before the Uniswap position did, so it was constructed with tokenId 0 and reads liquidity 0 forever.
///      That is not something to patch around with a setter: the whole point of an immutable backing position
///      is that a taker can read the order, read the vault, and know which position collateralises the book.
///      Redeploying costs one transaction, so the position is created first and the maker is pointed at it
///      afterwards.
///
/// @dev The router, the two ERC20s and the position are all untouched by this, which is why this script
///      deliberately does not write `deployments/sepolia.json`. `solver/src/setup.ts` owns that file and
///      merges the new address into it.
///
/// @dev Usage, normally through `yarn setup`:
///      POSITION_TOKEN_ID=... ROUTER=... TOKEN_A=... TOKEN_B=... \
///      forge script contracts/script/DeployVault.s.sol --rpc-url sepolia --broadcast
contract DeployVault is Script {
    address internal constant AQUA = 0x499943E74FB0cE105688beeE8Ef2ABec5D936d31;
    address internal constant POSITION_MANAGER = 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;
    /// @notice Uniswap v4 StateView on Ethereum Sepolia, the read side of the PoolManager.
    address internal constant STATE_VIEW = 0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint8 internal constant MAX_UNWIND_PCT = 25;
    uint16 internal constant HAIRCUT_BPS = 500;

    /// @dev The instruction's conversion factor, in tokenOut units per unit of liquidity.
    ///
    ///      A position minted full range into a pool sitting at parity is worth one of each token per unit of
    ///      liquidity, so 1e18 was honest at the first deployment and is the default here. It stops being
    ///      honest the moment the pool moves: a full range unit is worth `sqrt(price)` of token1, so the live
    ///      book has been carrying 0.899173157285162368 since `yarn rebalance` moved the pool to tick -2126 and
    ///      `setRiskParams` recorded the measured figure.
    ///
    ///      A redeploy that silently reset this to 1e18 would re-open an 11% overstatement in the clamp, so the
    ///      value is an environment variable and the caller states it. `UNITS_PER_LIQUIDITY_E18=$(cast call
    ///      <old vault> 'unitsPerLiquidityE18()(uint128)')` carries it across unchanged, which is what a
    ///      redeploy of the guards rather than of the economics wants.
    uint128 internal constant DEFAULT_UNITS_PER_LIQUIDITY_E18 = 1e18;

    /// @dev Permit2 allowances carry an expiry. This is the largest value the type admits.
    uint48 internal constant MAX_EXPIRATION = type(uint48).max;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        uint256 tokenId = vm.envUint("POSITION_TOKEN_ID");
        address router = vm.envAddress("ROUTER");
        address tokenA = vm.envAddress("TOKEN_A");
        address tokenB = vm.envAddress("TOKEN_B");
        uint128 unitsPerLiquidityE18 =
            uint128(vm.envOr("UNITS_PER_LIQUIDITY_E18", uint256(DEFAULT_UNITS_PER_LIQUIDITY_E18)));

        require(tokenId != 0, "POSITION_TOKEN_ID must be the real position, create it first");
        require(router.code.length > 0, "ROUTER has no code");
        require(unitsPerLiquidityE18 > 0, "UNITS_PER_LIQUIDITY_E18 must be positive");

        vm.startBroadcast(deployerKey);

        BebecitaVault vault = new BebecitaVault(
            IAqua(AQUA),
            router,
            POSITION_MANAGER,
            STATE_VIEW,
            tokenId,
            deployer,
            MAX_UNWIND_PCT,
            HAIRCUT_BPS,
            unitsPerLiquidityE18
        );

        // Aqua moves the output token out of the vault on the last statement of every fill.
        vault.approveAqua(tokenA, type(uint256).max);
        vault.approveAqua(tokenB, type(uint256).max);

        // The redeposit is paid through Permit2, which needs both halves: the ERC20 allowance to Permit2 and
        // the Permit2 allowance to the position manager. This is the pair `/lp/check_approval` returns.
        vault.approve(tokenA, PERMIT2, type(uint256).max);
        vault.approve(tokenB, PERMIT2, type(uint256).max);
        vault.approveViaPermit2(PERMIT2, tokenA, POSITION_MANAGER, type(uint160).max, MAX_EXPIRATION);
        vault.approveViaPermit2(PERMIT2, tokenB, POSITION_MANAGER, type(uint160).max, MAX_EXPIRATION);

        vm.stopBroadcast();

        console.log("vault            ", address(vault));
        console.log("tokenId          ", tokenId);
        console.log("router           ", router);
        console.log("stateView        ", STATE_VIEW);
        console.log("unitsPerLiquidity", unitsPerLiquidityE18);
    }
}
