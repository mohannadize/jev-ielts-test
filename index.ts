/**
 * IELTS Scores Explained — server entry point.
 *
 * A single Bun process serving the built front end from `public/` and a small
 * JSON API. Designed to run as one container (Dokploy + Nixpacks), so state stays
 * in-process and nothing needs a backing store.
 *
 * Routes:
 *   GET  /                the app (static, from public/)
 *   GET  /healthz         liveness for the platform healthcheck, no diagnostics
 *   GET  /api/health      model, limits and whether a key is configured
 *   GET  /api/tasks       the built-in Task 2 questions
 *   GET  /api/tasks/random
 *   POST /api/evaluate    { prompt, response } -> band report
 *
 * The API key lives only in this process. It is never sent to the browser, never
 * logged, and any message returned to a visitor is a fixed string written here
 * rather than text from the upstream service.
 */

import { loadConfig } from "./src/config.ts";
import { MIN_WORDS, countWords } from "./src/ielts.ts";
import { TASKS, pickTask } from "./src/tasks.ts";
import { evaluateEssay } from "./src/evaluate.ts";
import { TypeSafeError } from "./src/typesafe.ts";
import { errorResponse, hardenResponse, htmlResponse, jsonResponse } from "./src/http.ts";
import { DailyCounter, SlidingWindow, clientIp, readBodyWithLimit } from "./src/security.ts";
import { contentTypeFor, etagFor, isNotModified, resolveAssetPath } from "./src/static.ts";

const config = loadConfig();

/** Per-client burst and daily budgets, plus the instance-wide daily ceiling. */
const perClientMinute = new SlidingWindow(config.rateLimit.perMinute, 60_000, config.rateLimit.maxTrackedClients);
const perClientDay = new SlidingWindow(config.rateLimit.perDay, 86_400_000, config.rateLimit.maxTrackedClients);
const instanceDay = new DailyCounter(config.rateLimit.globalPerDay);

interface EvaluatePayload {
  prompt?: unknown;
  response?: unknown;
}

function logLine(fields: Record<string, unknown>): void {
  if (!config.logRequests) return;
  console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
}

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found</title></head>
<body style="font:16px/1.5 system-ui;background:#0e1116;color:#e7ecf3;margin:0;display:grid;place-items:center;min-height:100vh">
<div style="text-align:center"><h1 style="margin:0 0 8px">404</h1>
<p style="margin:0 0 16px;color:#93a1b5">There is nothing at this address.</p>
<a href="/" style="color:#6ea8fe">Back to IELTS Scores Explained</a></div></body></html>`;

function notFound(request: Request): Response {
  return htmlResponse(NOT_FOUND_HTML, 404, request);
}

/** Serve one file from the asset directory, with caching and security headers. */
async function serveAsset(request: Request, pathname: string): Promise<Response> {
  const filePath = resolveAssetPath(config.staticDir, pathname);
  if (filePath === null) return notFound(request);

  const file = Bun.file(filePath);
  if (!(await file.exists())) return notFound(request);

  const contentType = contentTypeFor(filePath);
  if (contentType === null) return notFound(request);

  const etag = etagFor(file.size, file.lastModified);
  if (isNotModified(request, etag)) {
    return hardenResponse(new Response(null, { status: 304, headers: { ETag: etag } }), request);
  }

  const isDocument = filePath.endsWith(".html");
  return hardenResponse(
    new Response(request.method === "HEAD" ? null : file, {
      headers: {
        "Content-Type": contentType,
        ETag: etag,
        // Documents revalidate so a deploy takes effect immediately; the unhashed
        // assets around them are cached briefly rather than indefinitely.
        "Cache-Control": isDocument ? "no-cache" : "public, max-age=300, must-revalidate",
      },
    }),
    request,
  );
}

/** Translate an upstream failure into a message a visitor may read. */
function upstreamFailure(error: TypeSafeError, request: Request): Response {
  if (error.status === 401) {
    return errorResponse(
      "The evaluation service rejected this server's credentials. The site operator needs to check the API key.",
      503,
      "bad_api_key",
      request,
    );
  }
  if (error.status === 422) {
    return errorResponse("The evaluation service rejected the request.", 502, "rejected_request", request);
  }
  if (error.status === 429 || error.status === 529) {
    return errorResponse("The evaluation service is busy. Please try again in a moment.", 503, "upstream_busy", request);
  }
  if (error.status === 0) {
    return errorResponse("Could not reach the evaluation service. Please try again.", 504, "upstream_unreachable", request);
  }
  return errorResponse("The evaluation service returned an error. Please try again.", 502, "upstream_error", request);
}

async function handleEvaluate(request: Request, socketAddress: string | undefined): Promise<Response> {
  const started = Date.now();
  const client = clientIp(request, socketAddress, config.trustProxy);

  // Metered before anything is parsed, so a flood costs as little as possible.
  const minute = perClientMinute.tryConsume(client, started);
  if (!minute.allowed) {
    logLine({ event: "rate_limited", window: "minute", status: 429, client, ms: Date.now() - started });
    return errorResponse(
      `Too many evaluations from this address. Try again in ${minute.retryAfterSeconds} seconds.`,
      429,
      "rate_limited",
      request,
      { "Retry-After": String(minute.retryAfterSeconds) },
    );
  }

  const day = perClientDay.tryConsume(client, started);
  if (!day.allowed) {
    logLine({ event: "rate_limited", window: "day", status: 429, client, ms: Date.now() - started });
    return errorResponse(
      `This address has used its ${config.rateLimit.perDay} evaluations for today. Try again tomorrow.`,
      429,
      "daily_limit",
      request,
      { "Retry-After": String(day.retryAfterSeconds) },
    );
  }

  const capacity = instanceDay.tryConsume(new Date(started));
  if (!capacity.allowed) {
    logLine({ event: "capacity_reached", status: 503, client, ms: Date.now() - started });
    return errorResponse(
      "The site has reached its evaluation capacity for today. Please try again tomorrow.",
      503,
      "capacity",
      request,
      { "Retry-After": String(capacity.retryAfterSeconds) },
    );
  }

  const body = await readBodyWithLimit(request, config.maxBodyBytes);
  if (!body.ok) {
    logLine({ event: "body_rejected", reason: body.reason, status: 413, client, ms: Date.now() - started });
    return body.reason === "too_large"
      ? errorResponse(`Request body is larger than the ${config.maxBodyBytes}-byte limit.`, 413, "body_too_large", request)
      : errorResponse("Could not read the request body.", 400, "bad_body", request);
  }

  let payload: EvaluatePayload;
  try {
    payload = JSON.parse(body.text) as EvaluatePayload;
  } catch {
    return errorResponse("Request body must be JSON.", 400, "bad_json", request);
  }

  const { prompt, response } = payload;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return errorResponse("`prompt` must be a non-empty string.", 400, "bad_prompt", request);
  }
  if (prompt.length > config.maxPromptChars) {
    return errorResponse(`The question is longer than the ${config.maxPromptChars}-character limit.`, 413, "prompt_too_long", request);
  }
  if (typeof response !== "string") {
    return errorResponse("`response` must be a string.", 400, "bad_response", request);
  }

  const wordCount = countWords(response);
  if (wordCount > config.maxWords) {
    return errorResponse(
      `The answer is about ${wordCount} words, past this site's ${config.maxWords}-word limit. Task 2 asks for at least ${MIN_WORDS}.`,
      413,
      "too_long",
      request,
    );
  }

  if (config.apiKey === undefined) {
    logLine({ event: "missing_api_key", status: 503, client, ms: Date.now() - started });
    return errorResponse("This site has no evaluation service credentials configured.", 503, "missing_api_key", request);
  }

  try {
    const result = await evaluateEssay({
      prompt,
      response,
      apiKey: config.apiKey,
      model: config.model,
      minimumWords: config.minimumWords,
      deps: { timeoutMs: config.upstreamTimeoutMs },
    });

    logLine({
      event: "evaluated",
      status: 200,
      client,
      words: wordCount,
      band: result.overallBand,
      judgedBy: result.judgedBy,
      model: result.model,
      tokens: result.usage?.input_tokens ?? 0,
      ms: Date.now() - started,
    });
    return jsonResponse({ ok: true, result }, 200, request);
  } catch (error) {
    if (error instanceof TypeSafeError) {
      // Full detail to the log; a fixed message to the visitor.
      logLine({
        event: "upstream_failed",
        status: error.status,
        code: error.name,
        message: error.message,
        client,
        ms: Date.now() - started,
      });
      return upstreamFailure(error, request);
    }
    console.error("evaluate failed:", error);
    logLine({ event: "internal_error", status: 500, client, ms: Date.now() - started });
    return errorResponse("Something went wrong evaluating this answer.", 500, "internal_error", request);
  }
}

/**
 * Only the piece of the Bun server the handler needs. Keeping this structural
 * avoids tying the request path to the server's generic WebSocket parameter.
 */
interface SocketLookup {
  requestIP(request: Request): { address: string } | null;
}

async function handler(request: Request, server: SocketLookup): Promise<Response> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return errorResponse("Malformed request URL.", 400, "bad_request", request);
  }

  if (pathname === "/healthz") {
    return jsonResponse({ status: "ok" }, 200, request);
  }

  if (pathname === "/api/health" || pathname === "/api/tasks" || pathname.startsWith("/api/tasks/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse("Method not allowed.", 405, "method_not_allowed", request, { Allow: "GET, HEAD" });
    }
    if (pathname === "/api/health") {
      return jsonResponse(
        {
          ok: true,
          model: config.model,
          apiKeyConfigured: config.publicDiagnostics ? config.apiKey !== undefined : undefined,
          minimumWords: config.minimumWords,
          limits: { perMinute: config.rateLimit.perMinute, perDay: config.rateLimit.perDay, maxWords: config.maxWords },
        },
        200,
        request,
      );
    }
    if (pathname === "/api/tasks") return jsonResponse({ ok: true, tasks: TASKS }, 200, request);

    const exclude = new URL(request.url).searchParams.get("exclude") ?? undefined;
    return jsonResponse({ ok: true, task: pickTask(exclude) }, 200, request);
  }

  if (pathname === "/api/evaluate") {
    if (request.method !== "POST") {
      return errorResponse("Method not allowed.", 405, "method_not_allowed", request, { Allow: "POST" });
    }
    try {
      return await handleEvaluate(request, server.requestIP(request)?.address ?? undefined);
    } catch (error) {
      console.error("unhandled error in /api/evaluate:", error);
      return errorResponse("Something went wrong evaluating this answer.", 500, "internal_error", request);
    }
  }

  if (pathname.startsWith("/api/")) {
    return errorResponse("No such endpoint.", 404, "not_found", request);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse("Method not allowed.", 405, "method_not_allowed", request, { Allow: "GET, HEAD" });
  }

  return serveAsset(request, pathname);
}

const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  fetch: handler,
  // Development mode brings HMR tooling and a verbose error overlay; neither
  // belongs anywhere a visitor can reach.
  development: !config.production,
  idleTimeout: 30,
  error: (error) => {
    console.error("unhandled server error:", error);
    return errorResponse("Something went wrong handling this request.", 500, "internal_error");
  },
});

const appJs = Bun.file(new URL("./public/app.js", import.meta.url).pathname);
if (!(await appJs.exists())) {
  console.warn("public/app.js is missing — run `bun run build` so the page has its script.");
}

console.log(
  `IELTS Scores Explained listening on ${config.hostname}:${server.port} ` +
    `(model ${config.model}, ${config.production ? "production" : "development"} mode)`,
);
console.log(
  `limits: ${config.rateLimit.perMinute}/min and ${config.rateLimit.perDay}/day per address, ` +
    `${config.rateLimit.globalPerDay}/day in total, ${config.maxWords} words max, ` +
    `${config.maxBodyBytes} byte bodies, trustProxy=${config.trustProxy}`,
);
if (config.apiKey === undefined) {
  console.warn("TYPESAFE_API_KEY is not set — /api/evaluate will refuse to run until it is.");
}
if (!config.production) {
  console.warn("NODE_ENV is not production: development tooling is enabled. Set NODE_ENV=production when deployed.");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    void server.stop().then(() => process.exit(0));
  });
}