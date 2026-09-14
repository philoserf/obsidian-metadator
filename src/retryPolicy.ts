import { ClaudeApiError, type ClaudeErrorKind } from "./adapters/claude";

// The bulk run's retry and halt policy, kept free of any `obsidian` import so
// it can be exercised from a plain `bun run` script — the same reason
// `prompt.ts` and `emptyValue.ts` sit on their own. `bulkGenerate.ts` imports
// `obsidian` at module scope and that package ships types with no runtime, so
// anything living there is reachable only under the test mock.

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 8_000, 30_000,
];

// A run that fails this many times in a row with the same kind is failing
// systemically, not per-file. Retryable kinds (rate_limit, overloaded,
// connection) count toward it too, but only once runFileWithRetry has
// exhausted the whole backoff schedule for that file — by then they are a
// proven ceiling, not a blip.
export const DEFAULT_HALT_STREAK = 5;

// Why a run stopped before reaching every file. "auth" is decided on the first
// occurrence: a rejected key rejects every subsequent file too, so one
// round-trip is all the evidence needed. Everything else needs
// DEFAULT_HALT_STREAK in a row, because a single "api" or "unknown" is
// just as likely to be one bad note as a broken run.
// "other" covers failures that never reached the API — a frontmatter write
// against a read-only vault, say. Those are as systemic as any auth failure:
// every file fails identically.
export type HaltKind = ClaudeErrorKind | "other";

export function haltKindOf(error: unknown): HaltKind {
  return error instanceof ClaudeApiError ? error.kind : "other";
}

// The retry policy, as the two-row table it is. A kind present here is
// retryable; absent means fail on the first error. `maxRetries` caps how much
// of the caller's delay schedule the kind takes — omitted means the whole
// schedule, so a test passing a custom schedule gets exactly that schedule.
// `haltStreak` overrides DEFAULT_HALT_STREAK.
//
// Keyed on HaltKind, not ClaudeErrorKind: haltStreakFor is called with
// haltKindOf's output, which returns "other" for anything that is not a
// ClaudeApiError, and "other" is not a member of ClaudeErrorKind.
//
// A connection failure is not a throttle. A rate limit means the server heard
// us and said no, so waiting is meaningful and later files may still succeed;
// a connection failure means we never reached it, and each attempt burns the
// full request timeout three times over because the SDK retries underneath us.
// So it gets a shorter schedule and a shorter streak. On a hung socket —
// established but silent, unlike a refused connection, which fails fast — the
// full policy took about an hour to give up on a dead network (#221).
export const RETRY_POLICY: Partial<
  Record<HaltKind, { maxRetries?: number; haltStreak?: number }>
> = {
  rate_limit: {},
  overloaded: {},
  connection: { maxRetries: 2, haltStreak: 2 },
};

// Object.hasOwn, not `in`: a Partial<Record<...>> lookup on a prototype key
// would otherwise pass.
export function isRetryable(error: unknown): boolean {
  return (
    error instanceof ClaudeApiError && Object.hasOwn(RETRY_POLICY, error.kind)
  );
}

// A prefix of the caller's schedule rather than its own constant, so a test
// passing zero delays gets zero delays here too.
export function scheduleFor(
  error: unknown,
  delays: readonly number[],
): readonly number[] {
  const kind = haltKindOf(error);
  return delays.slice(0, RETRY_POLICY[kind]?.maxRetries ?? delays.length);
}

export function haltStreakFor(kind: HaltKind): number {
  return RETRY_POLICY[kind]?.haltStreak ?? DEFAULT_HALT_STREAK;
}

// Cap server-provided Retry-After at this multiple of the scheduled base
// delay so a misbehaving header can't stall a long bulk run indefinitely.
const RETRY_AFTER_CAP_MULTIPLIER = 2;

export function computeDelayMs(
  baseDelayMs: number,
  error: unknown,
  random: () => number = Math.random,
): number {
  if (
    error instanceof ClaudeApiError &&
    error.retryAfterMs !== undefined &&
    Number.isFinite(error.retryAfterMs)
  ) {
    return Math.min(
      error.retryAfterMs,
      baseDelayMs * RETRY_AFTER_CAP_MULTIPLIER,
    );
  }
  // Full jitter in [0.5x, 1.5x] of base — avoids synchronized retry storms
  // across parallel clients hitting a shared-tenant overload.
  return Math.round(baseDelayMs * (0.5 + random()));
}
