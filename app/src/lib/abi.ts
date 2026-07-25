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
  'function swap((address maker, uint256 traits, bytes data) order, uint256 amount, bytes takerTraitsAndData) payable returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
])

export const aquaAbi = parseAbi([
  'function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)',
])

/**
 * The events the dashboard reads back.
 *
 * `Shipped` is the vault's own, and its `strategyHash` is indexed, which is what makes the full list of
 * strategies a single `eth_getLogs` rather than a walk of the salt space. `Swapped` is SwapVM's, with no
 * indexed parameter at all, so it is filtered by address and decoded here.
 */
export const vaultEventsAbi = parseAbi([
  'event Shipped(bytes32 indexed strategyHash, address indexed app)',
  'event Unwound(bytes32 indexed orderHash, address indexed token, uint256 released, uint256 required)',
  'event Redeposited(bytes32 indexed orderHash, uint256 liquidityBefore, uint256 liquidityAfter)',
])

export const routerEventsAbi = parseAbi([
  'event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
])

export const poolManagerEventsAbi = parseAbi([
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
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

/**
 * The demo pair is `TestERC20`, whose `mint` is public on purpose: the taker is now whoever presses the
 * button, so a judge has to be able to fund and approve their own wallet without asking anyone for tokens.
 * The allowance goes to the router, not to Aqua, because `useTransferFromAndAquaPush` makes the router pull
 * the input and push it into Aqua on the taker's behalf.
 */
export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
])
