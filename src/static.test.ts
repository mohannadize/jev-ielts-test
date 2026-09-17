import { describe, expect, test } from "bun:test";

import { contentTypeFor, etagFor, isNotModified, resolveAssetPath } from "./static.ts";

const ROOT = "/tmp/asset-root";

describe("contentTypeFor", () => {
  test("serves the asset types the front end needs", () => {
    expect(contentTypeFor("/x/index.html")).toContain("text/html");
    expect(contentTypeFor("/x/styles.css")).toContain("text/css");
    expect(contentTypeFor("/x/app.js")).toContain("text/javascript");
    expect(contentTypeFor("/x/favicon.svg")).toBe("image/svg+xml");
  });

  test("refuses source, environment and mapping files", () => {
    expect(contentTypeFor("/x/app.ts")).toBeNull();
    expect(contentTypeFor("/x/app.js.map")).toBeNull();
    expect(contentTypeFor("/x/.env")).toBeNull();
    expect(contentTypeFor("/x/notes.md")).toBeNull();
    expect(contentTypeFor("/x/nixpacks.toml")).toBeNull();
    expect(contentTypeFor("/x/wrangler.yaml")).toBeNull();
  });

  test("refuses a file with no extension", () => {
    expect(contentTypeFor("/x/LICENSE")).toBeNull();
    expect(contentTypeFor("/x/passwd")).toBeNull();
  });
});

describe("resolveAssetPath", () => {
  test("maps the root to index.html", () => {
    expect(resolveAssetPath(ROOT, "/")).toBe(`${ROOT}/index.html`);
    expect(resolveAssetPath(ROOT, "")).toBe(`${ROOT}/index.html`);
  });

  test("maps a normal asset", () => {
    expect(resolveAssetPath(ROOT, "/app.js")).toBe(`${ROOT}/app.js`);
    expect(resolveAssetPath(ROOT, "/styles.css")).toBe(`${ROOT}/styles.css`);
    expect(resolveAssetPath(ROOT, "/sub/nested.svg")).toBe(`${ROOT}/sub/nested.svg`);
    expect(resolveAssetPath(ROOT, "//styles.css")).toBe(`${ROOT}/styles.css`);
  });

  test("refuses directory traversal, plain and encoded", () => {
    expect(resolveAssetPath(ROOT, "/../etc/passwd")).toBeNull();
    expect(resolveAssetPath(ROOT, "/sub/../../etc/passwd")).toBeNull();
    expect(resolveAssetPath(ROOT, "/%2e%2e/etc/passwd")).toBeNull();
    expect(resolveAssetPath(ROOT, "/..%2f..%2fetc/passwd")).toBeNull();
    expect(resolveAssetPath(ROOT, "/sub/%2e%2e/%2e%2e/app.js")).toBeNull();
  });

  test("refuses an absolute path escape", () => {
    // Leading slashes are stripped, so this resolves inside the root and then
    // fails the extension allow-list rather than leaving the directory.
    const resolved = resolveAssetPath(ROOT, "/etc/shadow");
    expect(resolved).toBeNull();
  });

  test("refuses dotfiles anywhere in the path", () => {
    expect(resolveAssetPath(ROOT, "/.env")).toBeNull();
    expect(resolveAssetPath(ROOT, "/.git/config")).toBeNull();
    expect(resolveAssetPath(ROOT, "/nested/.hidden.js")).toBeNull();
  });

  test("refuses source files even though they sit in the project", () => {
    expect(resolveAssetPath(ROOT, "/src/rubric.ts")).toBeNull();
    expect(resolveAssetPath(ROOT, "/frontend/app.ts")).toBeNull();
  });

  test("refuses NUL bytes, overlong paths and malformed encoding", () => {
    expect(resolveAssetPath(ROOT, "/app.js%00.png")).toBeNull();
    expect(resolveAssetPath(ROOT, `/${"a".repeat(600)}.js`)).toBeNull();
    expect(resolveAssetPath(ROOT, "/%E0%A4%A.js")).toBeNull();
  });

  test("refuses a trailing separator so each asset has one URL", () => {
    expect(resolveAssetPath(ROOT, "/styles.css/")).toBeNull();
    expect(resolveAssetPath(ROOT, "/sub//app.js")).toBeNull();
    expect(resolveAssetPath(ROOT, "//")).toBeNull();
  });
});

describe("caching helpers", () => {
  test("the etag changes when size or modification time does", () => {
    const first = etagFor(1_234, 1_700_000_000_000);
    expect(first).toBe('W/"1234-1700000000000"');
    expect(etagFor(1_235, 1_700_000_000_000)).not.toBe(first);
    expect(etagFor(1_234, 1_700_000_001_000)).not.toBe(first);
  });

  test("if-none-match is matched exactly, in a list, or as a wildcard", () => {
    const etag = etagFor(10, 20);
    const withHeader = (value: string) => new Request("https://example.test/app.js", { headers: { "if-none-match": value } });

    expect(isNotModified(withHeader(etag), etag)).toBe(true);
    expect(isNotModified(withHeader(`"other", ${etag}`), etag)).toBe(true);
    expect(isNotModified(withHeader("*"), etag)).toBe(true);
    expect(isNotModified(withHeader('"stale"'), etag)).toBe(false);
    expect(isNotModified(new Request("https://example.test/app.js"), etag)).toBe(false);
  });
});