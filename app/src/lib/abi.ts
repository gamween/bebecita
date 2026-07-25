import { parseAbi } from 'viem'

/**
 * Minimal ABIs, written against the deployed sources rather than generated, so the app carries no build
 * dependency on `forge build` output (which is gitignored).
 */

export const vaultAbi = parseAbi([
  'function AQUA() view returns (address)',
  'function ROUTER() view returns (address)',
  'function POSITION_MANAGER() view returns (address)',
  'function TOKEN_ID() view returns (uint256)',
  'function OWNER() view returns (address)',
  'function maxUnwindPct() view returns (uint8)',
  'function haircutBps() view returns (uint16)',
  'function unitsPerLiquidityE18() view returns (uint128)',
  'function reachableFromPosition() view returns (uint256)',
  'function getReserves((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint256 token0, uint256 token1)',
  'function getEffectiveLiquidity((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint256 token0, uint256 token1)',
  'function hook() view returns (address)',
  'function executeOnPositionManager(bytes payload, uint256 value) payable returns (bytes)',
])

/**
 * `quote()` is declared non-view in SwapVM and is meant to be reached through `asView()`, that is, through a
 * staticcall. It is typed `view` here so viem sends `eth_call`, which is the same staticcall.
 */
export const routerAbi = parseAbi([
  'function AQUA() view returns (address)',
  'function OPCODE_UNWIND_PRICED_BALANCE_OUT() view returns (uint256)',
  'function hash((address maker, uint256 traits, bytes data) order) view returns (bytes32)',
  'function quote((address maker, uint256 traits, bytes data) order, uint256 amount, bytes takerTraitsAndData) view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
])

export const aquaAbi = parseAbi([
  'function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)',
])

/** `getPositionLiquidity(uint256)` is selector 0x1efeed33, the one the instruction and the vault both call. */
export const positionManagerAbi = parseAbi([
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function ownerOf(uint256 tokenId) view returns (address)',
])

export const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
])

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
])
