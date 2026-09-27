/**
 * Refresh the hand-kept `tested` arrays from live installs.
 *
 * Run: pnpm compat:record [--dry-run]
 *   default writes runtimes/<id>/definition.ts in place (append-only);
 *   --dry-run prints what would change and writes nothing.
 *
 * No thought required after a CLI upgrade: observed versions are merged
 * in, sorted, deduped — old entries are never removed (they stay as the
 * "older than tested" warn baseline). `opencode-acp` shares opencode's
 * policy object and is skipped. Uninstalled CLIs are skipped, never an
 * error. Requires network for nothing (detect() only).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimes } from "../src/runtimes.js";
import {
  mergeTestedVersions,
  recordFileFor,
  rewriteTestedArray,
  RECORD_RUNTIME_IDS,
} from "../src/discovery/compat-record.js";

const DRY_RUN = process.argv.includes("--dry-run");
const ROOT = process.cwd();

async function recordOne(id: string): Promise<void> {
  const file = recordFileFor(id);
  if (!file) {
    console.log(`${id}: shares another runtime's policy — skipped`);
    return;
  }
  const runtime = await runtimes.resolve(id);
  const status = await runtime.detect();
  if (!status.installed || !status.version) {
    console.log(`${id}: not installed or version unknown — skipped`);
    return;
  }
  const path = join(ROOT, file);
  const source = readFileSync(path, "utf-8");
  const existingMatch = /tested:\s*\[([^\]]*)\]/.exec(source);
  const existing = existingMatch?.[1]
    ? [...existingMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "")
    : [];
  const merged = mergeTestedVersions(existing, [status.version]);
  if (merged.join(",") === existing.join(",")) {
    console.log(`${id}: ${status.version} already recorded — no change`);
    return;
  }
  const next = rewriteTestedArray(source, merged);
  if (!next) {
    console.log(`${id}: no tested array found in ${file} — skipped`);
    return;
  }
  if (DRY_RUN) {
    console.log(`${id}: would record ${status.version} → [${merged.join(", ")}]`);
    return;
  }
  writeFileSync(path, next, "utf-8");
  console.log(`${id}: recorded ${status.version} → [${merged.join(", ")}]`);
}

async function main(): Promise<void> {
  for (const id of RECORD_RUNTIME_IDS) {
    try {
      await recordOne(id);
    } catch (err) {
      console.log(
        `${id}: probe failed (${err instanceof Error ? err.message : String(err)}) — skipped`,
      );
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
