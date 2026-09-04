import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface SessionRecord {
  id: string;
  nativeId: string;
  cwd: string;
  model?: string;
  updatedAt: number;
}

let customDir: string | null = null;

/** Override the session store directory (e.g. Electron app.getPath("userData")/sessions). Pass null to reset to default. */
export function setSessionStoreDir(dir: string | null): void {
  customDir = dir;
}

function storeDir(): string {
  if (customDir !== null) return customDir;
  const home = homedir();
  if (home) return join(home, ".agent-runtimes", "sessions");
  return join(tmpdir(), "agent-runtimes", "sessions");
}

function recordPath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(storeDir(), `${safe}.json`);
}

export function saveSessionRecord(record: SessionRecord): void {
  const dir = storeDir();
  mkdirSync(dir, { recursive: true });
  const tmp = `${recordPath(record.id)}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), "utf-8");
  writeFileSync(recordPath(record.id), JSON.stringify(record), "utf-8");
  try {
    rmSync(tmp, { force: true });
  } catch (_e: unknown) {
    String(_e);
  }
}

export function loadSessionRecord(id: string): SessionRecord | null {
  const file = recordPath(id);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf-8");
    const rec = JSON.parse(raw) as SessionRecord;
    if (typeof rec.nativeId === "string" && typeof rec.id === "string") return rec;
    return null;
  } catch (_e: unknown) {
    String(_e);
    return null;
  }
}

export function listSessionRecords(): SessionRecord[] {
  const dir = storeDir();
  if (!existsSync(dir)) return [];
  const out: SessionRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const rec = loadSessionRecord(id);
    if (rec) out.push(rec);
  }
  return out;
}

export function deleteSessionRecord(id: string): void {
  try {
    rmSync(recordPath(id), { force: true });
  } catch (_e: unknown) {
    String(_e);
  }
}

export function getSessionStoreDir(): string {
  return storeDir();
}

