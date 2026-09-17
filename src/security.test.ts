import { describe, expect, test } from "bun:test";

import { DailyCounter, SlidingWindow, clientIp, readBodyWithLimit } from "./security.ts";

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("https://example.test/api/evaluate", { headers });
}

describe("clientIp", () => {
  test("falls back to the socket address when forwarding headers are not trusted", () => {
    const request = requestWithHeaders({ "x-forwarded-for": "203.0.113.9" });
    expect(clientIp(request, "10.0.0.5", false)).toBe("10.0.0.5");
  });

  test("uses the right-most forwarding entry, which the proxy appended", () => {
    // The left-hand entry is whatever the client claimed; the proxy appends the
    // address it actually saw, so the right-most entry is the trustworthy one.
    const request = requestWithHeaders({ "x-forwarded-for": "1.2.3.4, 198.51.100.7" });
    expect(clientIp(request, "10.0.0.5", true)).toBe("198.51.100.7");
  });

  test("a client-supplied left-most entry cannot spoof the key", () => {
    const spoofed = requestWithHeaders({ "x-forwarded-for": "9.9.9.9, 198.51.100.7" });
    const honest = requestWithHeaders({ "x-forwarded-for": "8.8.8.8, 198.51.100.7" });
    expect(clientIp(spoofed, "10.0.0.5", true)).toBe(clientIp(honest, "10.0.0.5", true));
  });

  test("prefers the platform client header when the proxy provides it", () => {
    const request = requestWithHeaders({ "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "1.1.1.1" });
    expect(clientIp(request, "10.0.0.5", true)).toBe("203.0.113.10");
  });

  test("ignores unparseable header values instead of keying on them", () => {
    const request = requestWithHeaders({ "x-forwarded-for": "not-an-address, <script>" });
    expect(clientIp(request, "10.0.0.5", true)).toBe("10.0.0.5");
  });

  test("buckets everything as unknown when there is no usable address", () => {
    expect(clientIp(requestWithHeaders({}), undefined, true)).toBe("unknown");
    expect(clientIp(requestWithHeaders({}), "garbage value", false)).toBe("unknown");
  });
});

describe("SlidingWindow", () => {
  test("allows up to the limit inside one window", () => {
    const window = new SlidingWindow(3, 60_000);
    expect(window.tryConsume("a", 0).allowed).toBe(true);
    expect(window.tryConsume("a", 10).allowed).toBe(true);
    const third = window.tryConsume("a", 20);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  test("refuses the next hit and reports how long to wait", () => {
    const window = new SlidingWindow(2, 60_000);
    window.tryConsume("a", 0);
    window.tryConsume("a", 1_000);
    const blocked = window.tryConsume("a", 2_000);

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(58);
    expect(blocked.remaining).toBe(0);
  });

  test("the window slides, so capacity returns", () => {
    const window = new SlidingWindow(1, 60_000);
    expect(window.tryConsume("a", 0).allowed).toBe(true);
    expect(window.tryConsume("a", 30_000).allowed).toBe(false);
    expect(window.tryConsume("a", 60_001).allowed).toBe(true);
  });

  test("keys are independent", () => {
    const window = new SlidingWindow(1, 60_000);
    expect(window.tryConsume("a", 0).allowed).toBe(true);
    expect(window.tryConsume("b", 0).allowed).toBe(true);
    expect(window.tryConsume("a", 0).allowed).toBe(false);
  });

  test("a limit of zero disables the window", () => {
    const window = new SlidingWindow(0, 60_000);
    for (let hit = 0; hit < 100; hit += 1) {
      expect(window.tryConsume("a", 0).allowed).toBe(true);
    }
  });

  test("a flood of unique keys cannot grow memory without bound", () => {
    const window = new SlidingWindow(5, 60_000, 100);
    for (let index = 0; index < 5_000; index += 1) {
      window.tryConsume(`client-${index}`, 0);
    }
    expect(window.trackedKeys()).toBeLessThanOrEqual(100);
  });
});

describe("DailyCounter", () => {
  test("counts up to the ceiling then refuses until the next UTC day", () => {
    const counter = new DailyCounter(2);
    const morning = new Date("2026-09-18T08:00:00Z");

    expect(counter.tryConsume(morning).allowed).toBe(true);
    expect(counter.tryConsume(morning).allowed).toBe(true);
    const blocked = counter.tryConsume(morning);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(16 * 3600);
  });

  test("resets when the UTC date changes", () => {
    const counter = new DailyCounter(1);
    expect(counter.tryConsume(new Date("2026-09-18T23:59:00Z")).allowed).toBe(true);
    expect(counter.tryConsume(new Date("2026-09-18T23:59:30Z")).allowed).toBe(false);
    expect(counter.tryConsume(new Date("2026-09-19T00:00:01Z")).allowed).toBe(true);
  });

  test("a ceiling of zero disables the cap", () => {
    const counter = new DailyCounter(0);
    const now = new Date("2026-09-18T12:00:00Z");
    for (let hit = 0; hit < 50; hit += 1) {
      expect(counter.tryConsume(now).allowed).toBe(true);
    }
  });
});

describe("readBodyWithLimit", () => {
  test("reads a body inside the limit", async () => {
    const request = new Request("https://example.test/api/evaluate", { method: "POST", body: '{"a":1}' });
    const result = await readBodyWithLimit(request, 1_024);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('{"a":1}');
  });

  test("treats a missing body as empty", async () => {
    const request = new Request("https://example.test/api/evaluate", { method: "POST" });
    const result = await readBodyWithLimit(request, 1_024);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("");
  });

  test("refuses a body over the limit", async () => {
    const request = new Request("https://example.test/api/evaluate", {
      method: "POST",
      body: "x".repeat(2_000),
    });
    const result = await readBodyWithLimit(request, 1_024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_large");
  });

  test("stops a streamed body that exceeds the limit, without a content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("y".repeat(4_000)));
        controller.close();
      },
    });
    const request = new Request("https://example.test/api/evaluate", {
      method: "POST",
      body: stream,
    } as RequestInit);

    const result = await readBodyWithLimit(request, 1_024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_large");
  });
});