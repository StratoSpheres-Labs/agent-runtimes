import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
    },
    format: ["esm"],
    dts: {
      // Inline shared declarations so dist/index.d.ts is self-contained
      // (avoids a .d.ts-only chunk that references a non-existent .js).
      resolve: true,
    },
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    target: "node20",
  },
  {
    // CLI needs no .d.ts (avoids reintroducing shared declaration chunks);
    // splitting:false keeps it a single self-contained file.
    entry: {
      cli: "src/cli.ts",
    },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    // Browser-safe entry (`@stratosphereslab/agent-runtimes/assistant-ui`).
    // It must never reach a `node:` builtin — a renderer importing the package
    // ROOT would drag in `node:child_process`, so the adapter ships on its
    // own subpath with its own build. es2022 (browsers, not Node), dts on so
    // consumers get the types, zero external deps.
    entry: {
      "assistant-ui": "src/frontend/assistant-ui/index.ts",
    },
    format: ["esm"],
    dts: {
      // Inline shared declarations so dist/assistant-ui.d.ts is self-contained.
      resolve: true,
    },
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    platform: "browser",
    target: "es2022",
  },
]);
