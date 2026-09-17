import { describe, expect, test } from "bun:test";

import { errorResponse, hardenResponse, isHttps, jsonResponse, securityHeaders } from "./http.ts";

const plain = new Request("http://example.test/api/health");
const overTls = new Request("https://example.test/api/health");
const behindProxyTls = new Request("http://example.test/api/health", { headers: { "x-forwarded-proto": "https" } });

describe("securityHeaders", () => {
  test("the content policy allows only same-origin assets and no inline script", () => {
    const policy = securityHeaders()["Content-Security-Policy"] ?? "";

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  test("the usual hardening headers are present", () => {
    const headers = securityHeaders();
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
  });

  test("HSTS is only sent over TLS", () => {
    expect(securityHeaders()["Strict-Transport-Security"]).toBeUndefined();
    expect(securityHeaders({ https: true })["Strict-Transport-Security"]).toContain("max-age=");
  });
});

describe("isHttps", () => {
  test("detects TLS from the URL and from the proxy header", () => {
    expect(isHttps(overTls)).toBe(true);
    expect(isHttps(behindProxyTls)).toBe(true);
    expect(isHttps(plain)).toBe(false);
    expect(isHttps(new Request("http://example.test/", { headers: { "x-forwarded-proto": "http" } }))).toBe(false);
  });
});

describe("jsonResponse", () => {
  test("is uncacheable and hardened", async () => {
    const response = jsonResponse({ ok: true }, 200, plain);

    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.json()).toEqual({ ok: true });
  });

  test("adds HSTS when the request arrived over TLS", () => {
    expect(jsonResponse({}, 200, overTls).headers.get("Strict-Transport-Security")).not.toBeNull();
    expect(jsonResponse({}, 200, plain).headers.get("Strict-Transport-Security")).toBeNull();
  });
});

describe("errorResponse", () => {
  test("carries a code, a status and a visitor-readable message", async () => {
    const response = errorResponse("Too many evaluations from this address.", 429, "rate_limited", plain, {
      "Retry-After": "30",
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      error: { message: "Too many evaluations from this address.", code: "rate_limited", status: 429 },
    });
  });
});

describe("hardenResponse", () => {
  test("keeps the original status and headers and adds the security set", () => {
    const original = new Response("<html></html>", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", ETag: 'W/"1-1"' },
    });

    const hardened = hardenResponse(original, overTls);

    expect(hardened.status).toBe(404);
    expect(hardened.headers.get("Content-Type")).toContain("text/html");
    expect(hardened.headers.get("ETag")).toBe('W/"1-1"');
    expect(hardened.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(hardened.headers.get("Strict-Transport-Security")).not.toBeNull();
  });
});