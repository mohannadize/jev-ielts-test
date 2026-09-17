/**
 * Static asset serving for the built front end in `public/`.
 *
 * Deliberately narrow: an allow-list of extensions, a path that must resolve
 * inside the asset root, and no directory listing. Source files, dotfiles and
 * anything else that happens to sit in the directory are never served.
 */

import { basename, extname, resolve, sep } from "node:path";

const CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
]);

/** Never served, even if present: source and environment files. */
const DENIED_EXTENSIONS = new Set([".ts", ".tsx", ".md", ".map", ".lock", ".env", ".yaml", ".yml", ".toml"]);

export function contentTypeFor(path: string): string | null {
  const extension = extname(path).toLowerCase();
  if (DENIED_EXTENSIONS.has(extension)) return null;
  if (extension === "") return null;
  return CONTENT_TYPES.get(extension) ?? null;
}

/**
 * Map a request path to a file inside `root`, or null when it must not be served.
 *
 * Rejects encoded traversal, NUL bytes, absolute paths, and anything that
 * resolves outside the asset root after normalisation.
 */
export function resolveAssetPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) return null;
  if (decoded.length > 512) return null;

  const relative = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/, "");
  if (relative.length === 0) return null;

  // One URL per asset: no trailing separator and no empty path segments, so the
  // same file cannot be reached through several spellings.
  if (relative.endsWith("/") || relative.includes("//")) return null;

  const assetRoot = resolve(root);
  const target = resolve(assetRoot, relative);

  // Must stay inside the root: blocks ../, absolute paths and encoded variants.
  // This is textual containment; symlinks inside the asset directory are not
  // resolved, which is fine because the directory holds only built assets.
  if (target !== assetRoot && !target.startsWith(assetRoot + sep)) return null;

  // A dotfile anywhere in the path (.env, .git/config, .DS_Store) is refused.
  if (basename(target).startsWith(".")) return null;
  if (target.split(sep).some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..")) return null;

  if (contentTypeFor(target) === null) return null;

  return target;
}

/** Cheap validator: size plus modification time. Strong enough for assets. */
export function etagFor(size: number, lastModified: number): string {
  return `W/"${size}-${Math.floor(lastModified)}"`;
}

export function isNotModified(request: Request, etag: string): boolean {
  const candidates = request.headers.get("if-none-match");
  if (candidates === null) return false;
  return candidates
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === etag || value === "*");
}