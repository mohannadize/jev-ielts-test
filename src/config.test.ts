import { describe, expect, test } from "bun:test";

import { loadConfig, resolveStaticDir } from "./config.ts";
import { DEFAULT_MODEL } from "./typesafe.ts";

describe("loadConfig", () => {
  test("runs with only an API key and safe defaults everywhere else", () => {
    const config = loadConfig({ TYPESAFE_API_KEY: "k-123" });

    expect(config.apiKey).toBe("k-123");
    expect(config.model).toBe(DEFAULT_MODEL);
    expect(config.port).toBe(3000);
    expect(config.hostname).toBe("0.0.0.0");
    expect(config.production).toBe(false);
    expect(config.maxWords).toBe(1200);
    expect(config.maxBodyBytes).toBe(65_536);
    expect(config.maxPromptChars).toBe(2_000);
    expect(config.upstreamTimeoutMs).toBe(20_000);
    expect(config.minimumWords).toBe(250);
    expect(config.rateLimit).toEqual({
      perMinute: 4,
      perDay: 30,
      globalPerDay: 300,
      maxTrackedClients: 20_000,
    });
  });

  test("a blank or whitespace key counts as unconfigured, not as a key", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "" }).apiKey).toBeUndefined();
    expect(loadConfig({ TYPESAFE_API_KEY: "   " }).apiKey).toBeUndefined();
    expect(loadConfig({}).apiKey).toBeUndefined();
  });

  test("NODE_ENV=production is what turns production mode on", () => {
    expect(loadConfig({ NODE_ENV: "production" }).production).toBe(true);
    expect(loadConfig({ NODE_ENV: "development" }).production).toBe(false);
    expect(loadConfig({ PRODUCTION: "1" }).production).toBe(true);
  });

  test("trustProxy defaults to on, because the documented deployment sits behind a proxy", () => {
    expect(loadConfig({}).trustProxy).toBe(true);
  });

  test("trustProxy can be turned off explicitly", () => {
    expect(loadConfig({ TRUST_PROXY: "0" }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: "false" }).trustProxy).toBe(false);
  });

  test("numeric settings accept overrides", () => {
    const config = loadConfig({
      PORT: "8080",
      MAX_WORDS: "500",
      RATE_LIMIT_PER_MINUTE: "1",
      RATE_LIMIT_PER_DAY: "5",
      GLOBAL_DAILY_LIMIT: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
    });

    expect(config.port).toBe(8080);
    expect(config.maxWords).toBe(500);
    expect(config.rateLimit.perMinute).toBe(1);
    expect(config.rateLimit.perDay).toBe(5);
    expect(config.rateLimit.globalPerDay).toBe(0);
    expect(config.upstreamTimeoutMs).toBe(5_000);
  });

  test("nonsense and negative numbers fall back rather than misconfigure a guard", () => {
    const config = loadConfig({
      PORT: "not-a-port",
      MAX_WORDS: "-5",
      MAX_BODY_BYTES: "abc",
      RATE_LIMIT_PER_MINUTE: "",
    });

    expect(config.port).toBe(3000);
    expect(config.maxWords).toBe(1200);
    expect(config.maxBodyBytes).toBe(65_536);
    expect(config.rateLimit.perMinute).toBe(4);
  });

  test("a zero limit is honoured, since 0 means disabled rather than unset", () => {
    expect(loadConfig({ MAX_WORDS: "0" }).maxWords).toBe(0);
  });

  test("the model can be overridden without changing code", () => {
    expect(loadConfig({ TYPESAFE_MODEL: "some-model" }).model).toBe("some-model");
    expect(loadConfig({ TYPESAFE_MODEL: "  " }).model).toBe(DEFAULT_MODEL);
  });
});

describe("resolveStaticDir", () => {
  test("defaults to the project's public directory regardless of the working directory", () => {
    const resolved = resolveStaticDir({});
    expect(resolved.endsWith("/public/")).toBe(true);
    expect(resolved).not.toContain("node_modules");
  });

  test("honours an explicit directory", () => {
    expect(resolveStaticDir({ STATIC_DIR: "/srv/assets" })).toBe("/srv/assets");
  });
});