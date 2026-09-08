import type { FastifyRequest } from "fastify";
import { ForgeError } from "../domain/errors.js";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Minimal in-process fixed-window throttle for unauthenticated routes.
 * Per-process enforcement: the effective global limit scales with the number
 * of server processes. Buckets are bounded; expired entries are swept first.
 */
export class Throttle {
  private buckets = new Map<string, Bucket>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  check(request: FastifyRequest, scope: string) {
    // request.ip is socket-derived; X-Forwarded-For is untrusted by default
    // (no trusted-proxy mode), so it must not key the limiter.
    const key = `${scope}:${request.ip}`;
    const now = Date.now();
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      if (this.buckets.size > 10000) {
        for (const [k, v] of this.buckets) {
          if (v.resetAt <= now) this.buckets.delete(k);
          if (this.buckets.size <= 10000) break;
        }
        while (this.buckets.size > 20000) {
          const oldest = this.buckets.keys().next().value;
          if (oldest === undefined) break;
          this.buckets.delete(oldest);
        }
      }
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    current.count += 1;
    if (current.count > this.limit)
      throw new ForgeError(
        "rate_limited",
        "Çok fazla istek; biraz bekleyip yeniden deneyin.",
        429,
      );
  }
}
