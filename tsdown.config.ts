import { defineConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
    entry: { index: "src/index.ts", react: "src/react.ts" },
    format: ["esm", "cjs"],
    platform: "neutral",
    target: "es2020",
    dts: true,
    sourcemap: true,
    clean: true,
    // React is a peer dependency — never bundle it.
    deps: { neverBundle: ["react", "react/jsx-runtime"] },
    // index.ts has named exports AND a default export (CacheEngine) — keep both reachable.
    outputOptions: { exports: "named" },
    // Single source of truth for the version: package.json.
    define: { __VERSION__: JSON.stringify(pkg.version) },
});
