/**
 * Browser-safety guard.
 *
 * `docs/frontend.md` Rule 0: the renderer must never import the library, and
 * the adapter subpath must never drag a `node:` builtin into a bundle. A
 * bundler resolves what the SOURCE imports, so this walks the transitive
 * relative-import graph from the adapter entry and fails on:
 *
 * - any `node:` builtin,
 * - any bare (non-relative) specifier, i.e. a runtime dependency creeping in
 *   — the whole point of shipping local structural types instead of importing
 *   assistant-ui's,
 * - reaching the Node-only core by accident (e.g. via `src/index.ts`, which
 *   imports `node:module`).
 *
 * This is a source-level check, so it runs without `pnpm build` first.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(ROOT, "src/frontend/assistant-ui/index.ts");

/**
 * Matches a whole import/export statement and captures its specifier, so we
 * can tell `import type` (erased at build time — must NOT be walked) from a
 * real runtime import (must be).
 */
const STATEMENT =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

interface Specifier {
  readonly value: string;
  /** True for `import type` / `export type` — erased, never bundled. */
  readonly typeOnly: boolean;
}

interface Edge {
  readonly from: string;
  readonly to: string;
}

function readSpecifiers(file: string): Specifier[] {
  const source = stripComments(readFileSync(file, "utf-8"));
  const found: Specifier[] = [];
  for (const match of source.matchAll(STATEMENT)) {
    const value = match[2] ?? match[3];
    if (value === undefined) continue;
    found.push({ value, typeOnly: match[1] !== undefined });
  }
  return found;
}

/** Strip comments so JSDoc examples (which quote specifiers) are not scanned. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");
}

/**
 * TS sources import each other with `.js` specifiers (NodeNext-style), which
 * on disk are `.ts` files. Map back so the graph walk finds real files.
 */
function resolveSpecifier(fromFile: string, specifier: string): string {
  const target = resolve(dirname(fromFile), specifier);
  if (existsSync(target)) return target;
  if (target.endsWith(".js")) {
    const asTs = `${target.slice(0, -3)}.ts`;
    if (existsSync(asTs)) return asTs;
  }
  return target;
}

function relativeOf(file: string): string {
  return file.slice(ROOT.length + 1).replaceAll("\\", "/");
}

/**
 * Breadth-first walk of the RUNTIME relative-import graph.
 *
 * Type-only edges are excluded on purpose: `verbatimModuleSyntax` erases
 * `import type` before a bundler ever sees it, so following them would report
 * `node:fs` imports that never reach the output. They are still worth knowing
 * about, so they are collected separately for the reachability assertions.
 */
function walk(): {
  files: string[];
  edges: Edge[];
  externals: Edge[];
  typeOnlyEdges: Edge[];
} {
  const seen = new Set<string>([ENTRY]);
  const files: string[] = [];
  const edges: Edge[] = [];
  const externals: Edge[] = [];
  const typeOnlyEdges: Edge[] = [];
  const queue = [ENTRY];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined) break;
    files.push(relativeOf(file));
    for (const { value: specifier, typeOnly } of readSpecifiers(file)) {
      if (specifier.startsWith(".")) {
        if (typeOnly) {
          typeOnlyEdges.push({ from: relativeOf(file), to: specifier });
          continue;
        }
        const next = resolveSpecifier(file, specifier);
        edges.push({ from: relativeOf(file), to: specifier });
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      } else {
        externals.push({ from: relativeOf(file), to: specifier });
      }
    }
  }
  return { files, edges, externals, typeOnlyEdges };
}

const GRAPH = walk();

describe("assistant-ui entry is browser-safe", () => {
  it("pulls in no node: builtin", () => {
    const nodeImports = GRAPH.externals.filter((e) => e.to.startsWith("node:"));
    expect(nodeImports).toEqual([]);
  });

  it("has zero bare runtime dependencies", () => {
    // A bare specifier here means the browser bundle would need a dependency
    // resolution step — exactly what the local structural types avoid.
    expect(GRAPH.externals).toEqual([]);
  });

  it("never reaches the Node-only package root", () => {
    // `src/core/errors.ts` is the ONE sanctioned core borrow (pure error
    // classes, no builtin). Anything else under `src/core/`, and the root
    // entry itself, would drag `node:child_process` in behind it.
    expect(GRAPH.files).not.toContain("src/index.ts");
    const coreModules = GRAPH.files.filter((f) => f.startsWith("src/core/"));
    expect(coreModules).toEqual(["src/core/errors.ts"]);
  });

  it("reaches only the modules it claims to", () => {
    // Runtime graph, excluding erased `import type` edges. Two modules are
    // legitimately absent: `types.ts` (a pure type module — nothing but
    // interfaces, so it vanishes entirely) and `events/runtime-event.ts`
    // (`RuntimeEvent` is a type). Both still shape the emitted .d.ts.
    expect(GRAPH.files.sort()).toEqual([
      "src/core/errors.ts",
      "src/frontend/assistant-ui/chat-model.ts",
      "src/frontend/assistant-ui/external-store.ts",
      "src/frontend/assistant-ui/fold.ts",
      "src/frontend/assistant-ui/index.ts",
      "src/frontend/assistant-ui/stream.ts",
      "src/frontend/assistant-ui/transport.ts",
      "src/wire.ts",
    ]);
  });

  it("borrows only two modules from the Node side, both pure", () => {
    // `src/wire.ts` (JSON framing) and `src/core/errors.ts` (error classes)
    // are the only runtime imports outside the adapter folder, and neither
    // touches a builtin — asserted above.
    const borrowed = GRAPH.files.filter((f) => !f.startsWith("src/frontend/assistant-ui/"));
    expect(borrowed.sort()).toEqual(["src/core/errors.ts", "src/wire.ts"]);
  });

  it("keeps its type-only imports off the runtime path", () => {
    // Type-only edges still shape the emitted .d.ts, so they are asserted for
    // awareness rather than ignored entirely.
    expect(GRAPH.typeOnlyEdges.length).toBeGreaterThan(0);
    // `RuntimeEvent` itself is the canonical erased edge.
    expect(GRAPH.typeOnlyEdges.some((e) => e.to.includes("events/runtime-event"))).toBe(true);
  });

  it("only borrows the pure JSON/error modules from the Node side", () => {
    // `src/wire.ts` and `src/core/errors.ts` are the only sanctioned
    // borrowings: pure JSON framing and the error classes, neither of which
    // touches a builtin.
    expect(GRAPH.edges.some((e) => e.to.includes("core/errors"))).toBe(true);
    expect(GRAPH.files).toContain("src/wire.ts");
  });

  it("the wire module itself stays builtin-free (it is what the browser borrows)", () => {
    const wireSpecifiers = readSpecifiers(resolve(ROOT, "src/wire.ts"));
    const builtins = wireSpecifiers.filter((s) => s.value.startsWith("node:")).map((s) => s.value);
    expect(builtins).toEqual([]);
  });
});

describe("package exports", () => {
  it("ships the adapter on its own subpath, not from the root entry", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports)).toContain("./assistant-ui");
    expect(pkg.exports["./assistant-ui"]).toMatchObject({
      types: "./dist/assistant-ui.d.ts",
      import: "./dist/assistant-ui.js",
    });
  });
});
