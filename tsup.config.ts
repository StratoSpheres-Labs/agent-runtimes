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
]);
