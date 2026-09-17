/**
 * Runtime configuration, read from the environment once at startup.
 *
 * Everything tunable lives here with a safe default, so the container needs only
 * the API key to run and every guard has an explicit, visible value.
 */

import { DEFAULT_MODEL } from "./typesafe.ts";

export interface RateLimitConfig {
  /** Evaluations allowed per client IP per minute. 0 disables the window. */
  perMinute: number;
  /** Evaluations allowed per client IP per day. 0 disables the window. */
  perDay: number;
  /**
   * Evaluations allowed across the whole instance per UTC day. 0 disables the cap.
   * This is the backstop that bounds spend even if per-IP limits are evaded
   * (rotating addresses, spoofed forwarding headers).
   */
  globalPerDay: number;
  /** Ceiling on distinct client keys held in memory, to bound memory use. */
  maxTrackedClients: number;
}

export interface Config {
  /** Undefined when the operator has not configured the key; the API refuses to run. */
  apiKey: string | undefined;
  model: string;
  port: number;
  hostname: string;
  production: boolean;
  /** Static asset directory, resolved independently of the working directory. */
  staticDir: string;
  /**
   * Whether to read the client address from forwarding headers. Only correct when
   * a trusted reverse proxy sits directly in front of this container.
   */
  trustProxy: boolean;
  /** Abort the upstream call after this long. */
  upstreamTimeoutMs: number;
  /** Largest accepted request body. */
  maxBodyBytes: number;
  /** Largest accepted question text. */
  maxPromptChars: number;
  /** Largest accepted answer, in words. */
  maxWords: number;
  minimumWords: number;
  rateLimit: RateLimitConfig;
  /** Log one line per API request. Essays and keys are never logged. */
  logRequests: boolean;
  /**
   * Whether /api/health reports whether a key is configured. Useful for the page,
   * and reveals nothing an attacker can act on beyond "the tool is configured".
   */
  publicDiagnostics: boolean;
}

function readInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function readBool(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Resolved from this file, not the working directory, so cwd never matters. */
export function resolveStaticDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.STATIC_DIR?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  return new URL("../public/", import.meta.url).pathname;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  const production = env.NODE_ENV === "production" ||
    readBool(env, "PRODUCTION", false);

  return {
    apiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined,
    model: env.TYPESAFE_MODEL?.trim() || DEFAULT_MODEL,
    port: readInt(env, "PORT", 3000),
    hostname: env.HOST?.trim() || "0.0.0.0",
    production,
    staticDir: resolveStaticDir(env),
    trustProxy: readBool(env, "TRUST_PROXY", true),
    upstreamTimeoutMs: readInt(env, "UPSTREAM_TIMEOUT_MS", 20_000),
    maxBodyBytes: readInt(env, "MAX_BODY_BYTES", 65_536),
    maxPromptChars: readInt(env, "MAX_PROMPT_CHARS", 2_000),
    maxWords: readInt(env, "MAX_WORDS", 1_200),
    minimumWords: readInt(env, "MINIMUM_WORDS", 250),
    rateLimit: {
      perMinute: readInt(env, "RATE_LIMIT_PER_MINUTE", 4),
      perDay: readInt(env, "RATE_LIMIT_PER_DAY", 30),
      globalPerDay: readInt(env, "GLOBAL_DAILY_LIMIT", 300),
      maxTrackedClients: readInt(env, "RATE_LIMIT_MAX_CLIENTS", 20_000),
    },
    logRequests: readBool(env, "LOG_REQUESTS", true),
    publicDiagnostics: readBool(env, "PUBLIC_DIAGNOSTICS", true),
  };
}