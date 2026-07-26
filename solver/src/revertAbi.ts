/**
 * Every custom error a fill on this book can revert with, in one list, so a revert prints its name.
 *
 * viem decodes a custom error only when its definition is in the ABI it was handed. The ABIs in this project
 * are hand written against the deployed sources and used to carry function fragments only, so every revert
 * arrived as "an error this app cannot decode, selector 0x...", which is the least useful sentence a guard can
 * produce: `UnwindShortfall(token, balanceAfter, required)` says the vault refused to pay out more than the
 * withdrawal released, and `0x1a2b3c4d` says nothing at all.
 *
 * This list is derived from sources, not from memory. Regenerating it is one grep:
 *
 *     grep -rhn '^\s*error ' contracts/src node_modules/@1inch/swap-vm/src node_modules/@1inch/aqua/src
 *
 * so a new error on any of those contracts costs exactly one line here. `app/src/lib/errors.ts` already walks
 * a viem error stack down to the decoded part and formats it, so nothing else has to change for a new name to
 * appear on screen.
 *
 * Scope, and why it is not simply everything under `node_modules`. The three sponsor libraries declare well
 * over sixty errors between them, most of them belonging to instructions this program never executes. What is
 * listed here is what the shipped order can actually reach: the vault and its instruction, the two traits
 * libraries every swap decodes through, the VM's own dispatch, the Aqua accounting the maker settles against,
 * the one curve this program prices on, and the ERC20 errors, which is where an Aqua shortfall really lands.
 *
 * Strings rather than a parsed ABI, so the caller can concatenate them onto its own function fragments and
 * `parseAbi` the result once. `as const` keeps the literal types viem's inference wants.
 */

/** `contracts/src/vault/BebecitaVault.sol`, the maker. */
const VAULT_ERRORS = [
  'error UnauthorizedCaller(address caller)',
  'error UnauthorizedOwner(address caller)',
  'error UnexpectedTarget(address target, address expected)',
  'error UnexpectedSelector(bytes4 selector)',
  'error PositionCallFailed(bytes returnData)',
  'error UnwindShortfall(address token, uint256 balanceAfter, uint256 required)',
  'error CollateralLeak(address token, uint256 balanceBefore, uint256 balanceAfter)',
  'error UnwindExceedsCap(uint256 liquidityBefore, uint256 liquidityAfter, uint8 maxUnwindPct)',
  'error RedepositReducedPosition(uint256 liquidityBefore, uint256 liquidityAfter)',
  'error PayloadTooShort()',
] as const

/** `contracts/src/instructions/UnwindPricedBalances.sol`, opcode `0x92`. */
const INSTRUCTION_ERRORS = [
  'error HaircutTooLarge(uint16 haircutBps)',
  'error UnwindShareOutOfRange(uint8 maxUnwindPct)',
  'error ZeroUnitsPerLiquidity()',
  'error InvalidArgsLength(uint256 length)',
  'error PositionLiquidityCallFailed(address positionManager, uint256 tokenId)',
  'error UnwindShouldBeCalledBeforeSwapAmountsComputation(uint256 amountIn, uint256 amountOut)',
] as const

/**
 * `@1inch/swap-vm/src/libs/TakerTraits.sol`.
 *
 * `TakerTraitsAmountOutMustBeGreaterThanZero` is the one worth recognising on sight: a misaligned taker traits
 * header decodes a different slice rather than failing to decode, so the VM prices against garbage and the
 * revert points at the amount instead of at the header. `contracts/test/TakerTraits.t.sol` exists to rule that
 * out, and this makes it legible when something else causes it.
 */
const TAKER_TRAITS_ERRORS = [
  'error TakerTraitsMissingTraits()',
  'error TakerTraitsMissingHookData()',
  'error TakerTraitsMissingHasPreTransferInFlag()',
  'error TakerTraitsMissingHasPreTransferOutFlag()',
  'error TakerTraitsThresholdLengthInvalid(bytes threshold)',
  'error TakerTraitsNonExactThresholdAmountIn(uint256 amountIn, uint256 amountThreshold)',
  'error TakerTraitsNonExactThresholdAmountOut(uint256 amountOut, uint256 amountThreshold)',
  'error TakerTraitsInsufficientMinOutputAmount(uint256 amountOut, uint256 amountOutMin)',
  'error TakerTraitsAmountOutMustBeGreaterThanZero(uint256 amountOut)',
  'error TakerTraitsExceedingMaxInputAmount(uint256 amountIn, uint256 amountInMax)',
  'error TakerTraitsTakerAmountInMismatch(uint256 takerAmount, uint256 computedAmount)',
  'error TakerTraitsTakerAmountOutMismatch(uint256 takerAmount, uint256 computedAmount)',
  'error TakerTraitsDeadlineExpired()',
] as const

/** `@1inch/swap-vm/src/libs/MakerTraits.sol`. Reached when the shipped order's header is malformed. */
const MAKER_TRAITS_ERRORS = [
  'error MakerTraitsMissingHookData()',
  'error MakerTraitsMissingHookTarget()',
  'error MakerTraitsMissingHasPreTransferInFlag()',
  'error MakerTraitsMissingHasPostTransferInFlag()',
  'error MakerTraitsMissingHasPreTransferOutFlag()',
  'error MakerTraitsMissingHasPostTransferOutFlag()',
  'error MakerTraitsTokensNotSorted()',
  'error MakerTraitsZeroAmountInNotAllowed()',
] as const

/**
 * `@1inch/swap-vm/src/SwapVM.sol` and `@1inch/swap-vm/src/libs/VM.sol`.
 *
 * `AquaBalanceInsufficientAfterTakerPush` is the router's own check that the taker's input really landed in
 * Aqua, and `UnknownOpcode` is what a program byte the VM does not implement decodes to. Both are dispatch
 * level, so neither can be attributed to a hook by reading a trace.
 */
const VM_ERRORS = [
  'error BadSignature(address maker, bytes32 orderHash, bytes signature)',
  'error AquaBalanceInsufficientAfterTakerPush(uint256 balance, uint256 preBalance, uint256 amount, uint256 amountNetPulled)',
  'error MakerTraitsUnwrapIsIncompatibleWithAqua()',
  'error MakerTraitsCustomReceiverIsIncompatibleWithAqua()',
  'error MsgValueInvalidToken()',
  'error NotEnoughMsgValueAttached()',
  'error UnexpectedMsgValue()',
  'error EthTransferFailed()',
  'error RunLoopExceedProgramLength(uint256 pc, uint256 programLength)',
  'error UnknownOpcode(uint256 opcode)',
] as const

/**
 * `@1inch/swap-vm/src/instructions/XYCConcentrate.sol`, opcode `0x51`, the curve this program prices on.
 *
 * `ConcentrateRecomputeDetected` is the guard that makes the instruction terminal: it fires when a second
 * pricing instruction tries to overwrite amounts it already computed.
 */
const CURVE_ERRORS = [
  'error ConcentrateInvalidPriceBounds(uint256 sqrtPriceMin, uint256 sqrtPriceMax)',
  'error ConcentrateRecomputeDetected(uint256 amountIn, uint256 amountOut)',
] as const

/**
 * `@1inch/aqua/src`, the maker's balance sheet.
 *
 * `PushToNonActiveStrategyPrevented` and `SafeBalancesForTokenNotInActiveStrategy` are what a docked or never
 * shipped strategy hash surfaces as, which is the most common state a replayed demo lands in.
 */
const AQUA_ERRORS = [
  'error InvalidAquaStrategy(address maker, bytes32 strategyHash, bytes32 salt, address app, address actualThis)',
  'error MissingTakerAquaPush(address token, uint256 newBalance, uint256 expectedBalance)',
  'error MissingNonReentrantModifier()',
  'error MaxNumberOfTokensExceeded(uint256 tokensCount, uint256 maxTokensCount)',
  'error StrategiesMustBeImmutable(address app, bytes32 strategyHash)',
  'error DockingShouldCloseAllTokens(address app, bytes32 strategyHash)',
  'error PushToNonActiveStrategyPrevented(address maker, address app, bytes32 strategyHash, address token)',
  'error SafeBalancesForTokenNotInActiveStrategy(address maker, address app, bytes32 strategyHash, address token)',
] as const

/**
 * The token layer, which is where an Aqua shortfall actually lands.
 *
 * `Aqua.pull` decrements the virtual balance first and calls `safeTransferFrom` afterwards, so a maker that
 * cannot cover the payout reverts with `ERC20InsufficientBalance` from the token rather than with an Aqua
 * error. Anyone reading the trace for an Aqua name will not find one, and this is why.
 *
 * Both SafeERC20 wrappers are listed because the two sides of a fill use different ones: the vault is on
 * OpenZeppelin's and the router is on 1inch's.
 */
const TOKEN_ERRORS = [
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InvalidSender(address sender)',
  'error ERC20InvalidReceiver(address receiver)',
  'error ERC20InvalidApprover(address approver)',
  'error ERC20InvalidSpender(address spender)',
  'error SafeERC20FailedOperation(address token)',
  'error SafeTransferFailed()',
  'error SafeTransferFromFailed()',
  'error ForceApproveFailed()',
  'error Permit2TransferAmountTooHigh()',
] as const

/**
 * The whole list, in the order a fill would meet them: the maker, its instruction, the traits both sides are
 * decoded from, the VM, the curve, Aqua, the token.
 */
export const REVERT_ERRORS = [
  ...VAULT_ERRORS,
  ...INSTRUCTION_ERRORS,
  ...TAKER_TRAITS_ERRORS,
  ...MAKER_TRAITS_ERRORS,
  ...VM_ERRORS,
  ...CURVE_ERRORS,
  ...AQUA_ERRORS,
  ...TOKEN_ERRORS,
] as const
