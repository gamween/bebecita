// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { BebecitaRouter } from "../src/routers/BebecitaRouter.sol";
import { BebecitaVault } from "../src/vault/BebecitaVault.sol";
import { TestERC20 } from "../src/mocks/TestERC20.sol";

/// @title Deploy
/// @notice Deploys the demo stack onto Ethereum Sepolia against the official Aqua.
///
/// @dev Nothing here redeploys Aqua. The router points at 0x499943E7..., the canonical Aqua address, whose
///      bytecode on Sepolia is byte for byte identical to the Base deployment. The 1inch track requires the
///      official contracts and allows redeploying a modified SwapVM, which is exactly what this does.
///
/// @dev Usage:
///      forge script contracts/script/Deploy.s.sol --rpc-url sepolia --broadcast --verify
contract Deploy is Script {
    /// @notice Official Aqua on Ethereum Sepolia, same address as every mainnet deployment.
    address internal constant AQUA = 0x499943E74FB0cE105688beeE8Ef2ABec5D936d31;
    /// @notice Uniswap v4 PositionManager on Ethereum Sepolia.
    address internal constant POSITION_MANAGER = 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;
    /// @notice Only a constructor argument. The demo pair is a pair of freshly minted test tokens.
    address internal constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;

    uint8 internal constant MAX_UNWIND_PCT = 25;
    uint16 internal constant HAIRCUT_BPS = 500;
    uint128 internal constant UNITS_PER_LIQUIDITY_E18 = 1e18;

    uint256 internal constant MINT_AMOUNT = 1_000_000 ether;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        uint256 tokenId = vm.envOr("POSITION_TOKEN_ID", uint256(0));

        require(AQUA.code.length > 0, "official Aqua not found on this chain");
        require(POSITION_MANAGER.code.length > 0, "v4 PositionManager not found on this chain");

        vm.startBroadcast(deployerKey);

        // Owning both sides of the pool is what makes the demo deterministic and replayable.
        TestERC20 tokenA = new TestERC20("Bebecita Alpha", "bALPHA", 18);
        TestERC20 tokenB = new TestERC20("Bebecita Bravo", "bBRAVO", 18);
        tokenA.mint(deployer, MINT_AMOUNT);
        tokenB.mint(deployer, MINT_AMOUNT);

        BebecitaRouter router = new BebecitaRouter(AQUA, WETH, deployer, "Bebecita", "1");

        BebecitaVault vault = new BebecitaVault(
            IAqua(AQUA),
            address(router),
            POSITION_MANAGER,
            tokenId,
            deployer,
            MAX_UNWIND_PCT,
            HAIRCUT_BPS,
            UNITS_PER_LIQUIDITY_E18
        );

        // The vault must let Aqua move tokens out, otherwise every pull reverts on allowance rather than
        // on anything to do with the program, which is a debugging trap worth avoiding up front.
        vault.approveAqua(address(tokenA), type(uint256).max);
        vault.approveAqua(address(tokenB), type(uint256).max);
        vault.approvePositionManager(address(tokenA), type(uint256).max);
        vault.approvePositionManager(address(tokenB), type(uint256).max);

        vm.stopBroadcast();

        console.log("chain            ", block.chainid);
        console.log("deployer         ", deployer);
        console.log("aqua (official)  ", AQUA);
        console.log("positionManager  ", POSITION_MANAGER);
        console.log("router           ", address(router));
        console.log("vault            ", address(vault));
        console.log("tokenA           ", address(tokenA));
        console.log("tokenB           ", address(tokenB));

        string memory json = string.concat(
            '{\n  "chainId": ', vm.toString(block.chainid),
            ',\n  "aqua": "', vm.toString(AQUA),
            '",\n  "positionManager": "', vm.toString(POSITION_MANAGER),
            '",\n  "router": "', vm.toString(address(router)),
            '",\n  "vault": "', vm.toString(address(vault)),
            '",\n  "tokenA": "', vm.toString(address(tokenA)),
            '",\n  "tokenB": "', vm.toString(address(tokenB)),
            '",\n  "deployer": "', vm.toString(deployer),
            '"\n}\n'
        );
        vm.writeFile("deployments/sepolia.json", json);
    }
}
