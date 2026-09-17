/**
 * HTTP helpers: JSON responses, client-facing errors, and the security headers
 * applied to every response this server produces.
 *
 * Client-facing errors carry a short, fixed message and a machine-readable code.
 * Upstream detail is never echoed to the browser; it is logged server-side only.
 */

export interface ApiErrorBody {
  ok: false;
  error: { message: string; code: string; status: number };
}

/** Set on every response. The app is self-hosted: same-origin assets only. */
const SECURITY_HEADERS: Record<string, string> = {
  // No external origins, no inline scripts, no framing, no form posts.
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export interface HeaderOptions {
  /** Adds HSTS. Only send over HTTPS, so plain-HTTP local use is unaffected. */
  https?: boolean;
}

export function securityHeaders(options: HeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = { ...SECURITY_HEADERS };
  if (options.https === true) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

/** True when the request reached us over TLS, directly or via the proxy. */
export function isHttps(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto");
  if (proto !== null) return proto.split(",")[0]?.trim() === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function jsonResponse(body: unknown, status = 200, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...securityHeaders({ https: request !== undefined && isHttps(request) }),
    },
  });
}

/**
 * A refusal the client is allowed to read. `message` must be written for the
 * visitor: no upstream bodies, no configuration values, no stack traces.
 */
export function errorResponse(
  message: string,
  status: number,
  code: string,
  request?: Request,
  extraHeaders: Record<string, string> = {},
): Response {
  const body: ApiErrorBody = { ok: false, error: { message, code, status } };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
      ...securityHeaders({ https: request !== undefined && isHttps(request) }),
    },
  });
}

/** Attach security headers to a response built elsewhere (static files, assets). */
export function hardenResponse(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders({ https: isHttps(request) }))) {
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Plain HTML page for the HTML responses (404), hardened the same way. */
export function htmlResponse(html: string, status: number, request: Request, extraHeaders: Record<string, string> = {}): Response {
  return hardenResponse(
    new Response(html, {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...extraHeaders,
      },
    }),
    request,
  );
}