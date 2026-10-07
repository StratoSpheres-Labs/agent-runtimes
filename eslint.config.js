import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // tests/fixtures holds executable test data (e.g. the mock ACP agent);
    // like *.jsonl fixtures it is not linted source. The config files are
    // excluded from type-aware linting for the same reason they were in
    // `allowDefaultProject`: they configure the build, they are not built.
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "tests/fixtures/",
      "*.config.js",
      "*.config.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Two projects on purpose: the Node root and the browser frontend
        // (`tsconfig.frontend.json` carries the DOM lib the adapter needs).
        // Naming both keeps type-aware linting working AND keeps `document`
        // out of the Node sources. `projectService` is not used because it
        // only discovers the nearest tsconfig.json, not sibling projects.
        project: ["./tsconfig.json", "./tsconfig.frontend.json"],
        // Build/config entry points configure the toolchain rather than ship;
        // they still get linted, just without the type-aware rules.
        allowDefaultProject: ["*.config.js", "*.config.ts"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-deprecated": "off",
    },
  },
  prettier,
);
