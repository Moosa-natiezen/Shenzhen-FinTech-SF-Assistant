/**
 * Rate limiting (T18 pen-test prep / Tech Spec §1 "API Gateway & Edge Layer —
 * Request Routing & Rate Limiting").
 *
 * Bypass-resistance design:
 *  - Money endpoints are keyed on the SERVER-RESOLVED session user id, never on
 *    a client-supplied header: rotating cookies, IPs, or spoofed X-Forwarded-For
 *    does not mint a new budget for the same authenticated user.
 *  - Credential endpoints (sign-in/sign-up) are keyed per client IP (the edge
 *    overwrites XFF; direct exposure must not trust client-set XFF — callers
 *    pass the already-trusted value).
 *  - Fixed windows with an injectable clock so tests need no sleeps.
 *  - In-memory state is correct for the single-process gateway; multi-instance
 *    production deployments should back this interface with Redis/edge limits
 *    (documented in LAUNCH_CHECKLIST.md).
 */
import type { Context, Next } from "hono";

export interface RateLimitRule {
  name: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const MAX_TRACKED_KEYS = 20_000;

export class RateLimiter {
  private windows = new Map<string, Window>();

  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, rule: RateLimitRule): RateLimitDecision {
    const t = this.now();
    // Opportunistic prune so a long-running process cannot grow unbounded.
    if (this.windows.size > MAX_TRACKED_KEYS) {
      for (const [k, w] of this.windows) {
        if (w.resetAt <= t) this.windows.delete(k);
      }
      // Still oversized after pruning: drop oldest-inserted entries.
      for (const k of this.windows.keys()) {
        if (this.windows.size <= MAX_TRACKED_KEYS) break;
        this.windows.delete(k);
      }
    }
    const key2 = `${rule.name}:${key}`;
    let w = this.windows.get(key2);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + rule.windowMs };
      this.windows.set(key2, w);
    }
    w.count += 1;
    const allowed = w.count <= rule.limit;
    return {
      allowed,
      remaining: Math.max(0, rule.limit - w.count),
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((w.resetAt - t) / 1000)),
    };
  }

  /** Test/dev hook. */
  reset(): void {
    this.windows.clear();
  }
}

/** Best-effort client IP from the edge-set forwarded header. */
export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return c.req.header("x-real-ip") ?? "unknown";
}

export interface RateLimitMiddlewareOptions extends RateLimitRule {
  limiter: RateLimiter;
  /**
   * Identity the budget is charged to. Return null to SKIP limiting (e.g. the
   * request is unauthenticated and the route already 401s on its own).
   */
  keyFn: (c: Context) => Promise<string | null> | string | null;
  /** Optional hook invoked when a request is throttled (alerting). */
  onThrottled?: (c: Context, key: string) => void;
}

/**
 * Hono middleware enforcing a fixed-window rate limit. Throttled requests get
 * 429 + Retry-After and an empty remaining budget signal.
 */
export function rateLimit(options: RateLimitMiddlewareOptions) {
  const { limiter, keyFn, onThrottled, ...rule } = options;
  return async (c: Context, next: Next): Promise<Response | void> => {
    const key = await keyFn(c);
    if (key === null) return next();
    const decision = limiter.hit(key, rule);
    c.header("X-RateLimit-Limit", String(rule.limit));
    c.header("X-RateLimit-Remaining", String(decision.remaining));
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSec));
      onThrottled?.(c, key);
      return c.json({ error: "Too many requests", code: "RATE_LIMITED" }, 429);
    }
    return next();
  };
}

/**
 * Production traffic profiles. In test mode the profiles are relaxed (same
 * code path, higher ceilings) because the existing suites fire hundreds of
 * requests from one simulated IP within a single run; the SECURITY suite
 * injects explicit small limits to prove enforcement and bypass-resistance.
 */
export interface RateLimitProfiles {
  /** Credential endpoints (sign-in/sign-up): brute-force defense, per IP. */
  auth: RateLimitRule;
  /** Money-movement endpoints: per authenticated user. */
  money: RateLimitRule;
  /** Global per-IP flood protection across the whole API surface. */
  global: RateLimitRule;
}

export function defaultRateLimitProfiles(nodeEnv: string | undefined): RateLimitProfiles {
  if (nodeEnv === "test") {
    return {
      auth: { name: "auth", limit: 1_000, windowMs: 60_000 },
      money: { name: "money", limit: 1_000, windowMs: 60_000 },
      global: { name: "global", limit: 5_000, windowMs: 60_000 },
    };
  }
  return {
    auth: { name: "auth", limit: 10, windowMs: 60_000 },
    money: { name: "money", limit: 30, windowMs: 60_000 },
    global: { name: "global", limit: 300, windowMs: 60_000 },
  };
}

/** Endpoints whose budget follows the authenticated user (not the IP). */
export const MONEY_PATHS = [
  "/api/fx/rate",
  "/api/fx/convert",
  "/api/funding/deposit",
  "/api/funding/transfer",
  "/api/tuition/pay",
] as const;
