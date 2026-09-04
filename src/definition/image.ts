/**
 * Agent-agnostic image input — Phase 26.
 * Path-primary (avoids pipe OOM, cross-platform safe, mirrors
 * `docs/cross-platform.md` file staging). Inline `data` is staged to a
 * temp file when the CLI requires a path flag (`-i`, `-f`).
 * Callers supply either `path` (existing file) or inline `data`+`mimeType`.
 */
export interface ImageInput {
  /** Absolute or cwd-relative file path. Takes precedence over `data`. */
  path?: string;
  /** Inline bytes or base64 string when no file path is available. */
  data?: Uint8Array | string;
  /** MIME, e.g. "image/png" — required when `data` is used. */
  mimeType?: string;
  /** Hint for staged filename when `data` is used. */
  filename?: string;
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function imageMimeFromPath(path: string, fallback = "image/png"): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return fallback;
}

export function imageToBase64(img: ImageInput, cwd?: string): { base64: string; mimeType: string } {
  if (img.data !== undefined) {
    const mime = img.mimeType ?? "image/png";
    const base64 =
      typeof img.data === "string" ? img.data : Buffer.from(img.data).toString("base64");
    return { base64, mimeType: mime };
  }
  if (img.path !== undefined) {
    const abs = isAbsolute(img.path) ? img.path : resolve(cwd ?? process.cwd(), img.path);
    if (!existsSync(abs)) throw new Error(`Image file not found: ${abs}`);
    const data = readFileSync(abs);
    const mime = img.mimeType ?? imageMimeFromPath(abs);
    return { base64: data.toString("base64"), mimeType: mime };
  }
  throw new Error("ImageInput requires either path or data");
}

export function stageImageToTempFile(img: ImageInput, cwd: string | undefined, hint = "img"): string {
  if (img.path !== undefined) {
    const abs = isAbsolute(img.path) ? img.path : resolve(cwd ?? process.cwd(), img.path);
    if (!existsSync(abs)) throw new Error(`Image file not found: ${abs}`);
    return abs;
  }
  if (img.data !== undefined) {
    const mime = img.mimeType ?? "image/png";
    const ext =
      mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : mime === "image/gif" ? ".gif" : ".png";
    const name = img.filename ?? `agent-runtimes-img-${hint}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}${ext}`;
    const file = join(tmpdir(), name);
    const bytes = typeof img.data === "string" ? Buffer.from(img.data, "base64") : Buffer.from(img.data);
    writeFileSync(file, bytes);
    return file;
  }
  throw new Error("ImageInput requires either path or data");
}

export function stagedIsTemp(path: string, _cwd: string | undefined): boolean {
  // Only staged `data` images use the agent-runtimes-img- prefix in tmpdir;
  // caller-owned files (even when cwd is under tmpdir) must not be deleted.
  return basename(path).startsWith("agent-runtimes-img-");
}
