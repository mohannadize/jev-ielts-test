/**
 * Abuse controls. A public evaluation endpoint spends the operator's API credits,
 * so every request is metered before it can reach the model.
 *
 * Three independent limits, all in-process (this app is designed to run as a
 * single container, so no shared store is needed):
 *   1. per client IP per minute — stops bursts;
 *   2. per client IP per day   — stops a patient single source;
 *   3. globally per day        — bounds total spend even if (1) and (2) are evaded
 *      by rotating addresses or spoofed forwarding headers.
 *
 * The counters live in memory, so a restart clears them. The global cap is what
 * makes that acceptable: it is the ceiling on what a day can cost.
 */

const IP_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;

function isPlausibleAddress(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && IP_PATTERN.test(value.trim());
}

/**
 * The client address used to key the per-IP limits.
 *
 * With `trustProxy`, the right-most `x-forwarded-for` entry is used: a reverse
 * proxy in front of this container appends the address it actually saw, so any
 * left-hand entries a client supplied cannot spoof the key. Without it, only the
 * socket address is trusted.
 */
export function clientIp(request: Request, socketAddress: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const cloudflare = request.headers.get("cf-connecting-ip");
    if (isPlausibleAddress(cloudflare)) return cloudflare.trim();

    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded !== null) {
      const parts = forwarded.split(",");
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const candidate = parts[index]?.trim();
        if (isPlausibleAddress(candidate)) return candidate;
      }
    }

    const realIp = request.headers.get("x-real-ip");
    if (isPlausibleAddress(realIp)) return realIp.trim();
  }

  return isPlausibleAddress(socketAddress) ? socketAddress.trim() : "unknown";
}

export interface LimitDecision {
  allowed: boolean;
  /** Seconds the client should wait before retrying. 0 when allowed. */
  retryAfterSeconds: number;
  remaining: number;
}

const ALLOWED_UNSET: LimitDecision = { allowed: true, retryAfterSeconds: 0, remaining: Number.MAX_SAFE_INTEGER };

/**
 * A sliding-window counter keyed by client. The window is exact — hits inside it
 * are counted from the recorded timestamps — so a client cannot reset its budget
 * by waiting for a fixed window to roll over.
 */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxTrackedKeys = 20_000,
  ) {}

  tryConsume(key: string, now: number): LimitDecision {
    if (this.limit <= 0) return ALLOWED_UNSET;

    const cutoff = now - this.windowMs;
    const recorded = this.hits.get(key);
    const recent = recorded === undefined ? [] : recorded.filter((at) => at > cutoff);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
        remaining: 0,
      };
    }

    recent.push(now);
    this.hits.set(key, recent);
    this.evictIfCrowded(cutoff);
    return { allowed: true, retryAfterSeconds: 0, remaining: this.limit - recent.length };
  }

  /**
   * Bound memory: drop entries with no hits inside the window, and if the map is
   * still oversized, drop oldest-inserted keys. A flood of unique keys (spoofed
   * addresses) can therefore never grow this without limit.
   */
  private evictIfCrowded(cutoff: number): void {
    if (this.hits.size <= this.maxTrackedKeys) return;
    for (const [key, times] of this.hits) {
      if (times.length === 0 || times[times.length - 1]! <= cutoff) this.hits.delete(key);
    }
    if (this.hits.size <= this.maxTrackedKeys) return;
    const excess = this.hits.size - this.maxTrackedKeys;
    let dropped = 0;
    for (const key of this.hits.keys()) {
      this.hits.delete(key);
      dropped += 1;
      if (dropped >= excess) break;
    }
  }

  /** Test/observability hook. */
  trackedKeys(): number {
    return this.hits.size;
  }
}

/** A counter that resets at 00:00 UTC, optionally with a hard ceiling. */
export class DailyCounter {
  private day = "";
  private count = 0;

  constructor(private readonly limit: number) {}

  tryConsume(now: Date): LimitDecision {
    const today = now.toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
    if (this.limit > 0 && this.count >= this.limit) {
      const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((nextDay - now.getTime()) / 1000)),
        remaining: 0,
      };
    }
    this.count += 1;
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: this.limit > 0 ? this.limit - this.count : Number.MAX_SAFE_INTEGER,
    };
  }

  used(): number {
    return this.count;
  }
}

export type BodyReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "unreadable" };

/**
 * Read a request body with a hard byte ceiling.
 *
 * `request.json()`/`text()` would buffer the whole body first, so an oversized
 * payload would already be in memory before any size check could run. This reads
 * the stream and stops as soon as the ceiling is passed.
 */
export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<BodyReadResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > maxBytes) return { ok: false, reason: "too_large" };
  }

  if (request.body === null) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(merged) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}