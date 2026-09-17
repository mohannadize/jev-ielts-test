/**
 * Guardrails on the copy that reaches visitors, and on the page's compatibility
 * with the strict content policy this server sends.
 *
 * The product rule is that the model is named only in the site footer: the
 * interface, headings, buttons and warnings describe what happened without
 * branding it. These tests fail if that erodes. The one unavoidable exception is
 * the model alias the API requires, which lives in `src/typesafe.ts`.
 */

import { describe, expect, test } from "bun:test";

const MODEL_NAME = /jev/i;

async function read(relative: string): Promise<string> {
  const file = Bun.file(new URL(relative, import.meta.url));
  if (!(await file.exists())) throw new Error(`missing file in test fixture: ${relative}`);
  return file.text();
}

function occurrences(haystack: string, needle: RegExp): number[] {
  const positions: number[] = [];
  const flags = needle.flags.includes("g") ? needle.flags : `${needle.flags}g`;
  const scanner = new RegExp(needle.source, flags);
  for (;;) {
    const match = scanner.exec(haystack);
    if (match === null) break;
    positions.push(match.index);
    if (match[0].length === 0) scanner.lastIndex += 1;
  }
  return positions;
}

describe("visitor-facing copy", () => {
  test("the browser app never names the model", async () => {
    const app = await read("../frontend/app.ts");
    expect(occurrences(app, MODEL_NAME)).toEqual([]);
  });

  test("the page names the model only inside the footer", async () => {
    const html = await read("../public/index.html");
    const matches = occurrences(html, MODEL_NAME);

    // The attribution must actually be there, in the footer and nowhere else.
    expect(matches.length).toBeGreaterThan(0);

    const footerStart = html.indexOf("<footer");
    const footerEnd = html.indexOf("</footer>");
    expect(footerStart).toBeGreaterThan(-1);
    expect(footerEnd).toBeGreaterThan(footerStart);

    for (const position of matches) {
      expect(position).toBeGreaterThan(footerStart);
      expect(position).toBeLessThan(footerEnd);
    }
  });

  test("the README does not name the model", async () => {
    const readme = await read("../README.md");
    expect(occurrences(readme, MODEL_NAME)).toEqual([]);
  });

  test("messages the server writes for visitors do not name the model", async () => {
    const files = [
      "../src/evaluate.ts",
      "../src/ielts.ts",
      "../src/rubric.ts",
      "../src/tasks.ts",
      "../src/http.ts",
      "../src/security.ts",
      "../src/static.ts",
      "../src/config.ts",
      "../index.ts",
    ];

    for (const file of files) {
      const source = await read(file);
      expect(`${file}: ${occurrences(source, MODEL_NAME).length}`).toBe(`${file}: 0`);
    }
  });

  test("the API-required model alias is confined to the client module", async () => {
    const glob = new Bun.Glob("*.ts");
    const withLiteral: string[] = [];

    for await (const entry of glob.scan(new URL(".", import.meta.url).pathname)) {
      if (entry.endsWith(".test.ts")) continue;
      const source = await read(`./${entry}`);
      if (occurrences(source, MODEL_NAME).length > 0) withLiteral.push(entry);
    }

    expect(withLiteral).toEqual(["typesafe.ts"]);
  });
});

describe("the page fits the content policy the server sends", () => {
  test("there is no inline script and no inline event handler", async () => {
    const html = await read("../public/index.html");

    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(html).not.toMatch(/\son(click|load|error|submit|change|input)\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  test("the script and stylesheet are same-origin relative paths", async () => {
    const html = await read("../public/index.html");

    expect(html).toContain('src="./app.js"');
    expect(html).toContain('href="./styles.css"');
    expect(html).not.toMatch(/src="https?:/i);
    expect(html).not.toMatch(/href="https?:[^"]*\.(css|js)"/i);
  });

  test("the app builds without any runtime dependency, so the image stays minimal", async () => {
    const packageJson = JSON.parse(await read("../package.json")) as {
      dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies ?? {}).toEqual({});
  });
});