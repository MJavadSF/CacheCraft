import { defineConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
    entry: {
        index: "src/index.ts",
        react: "src/react.ts",
        vue: "src/integrations/vue.ts",
        svelte: "src/integrations/svelte.ts",
        "tanstack-query": "src/integrations/tanstack-query.ts",
        fetch: "src/integrations/fetch.ts",
        opentelemetry: "src/integrations/opentelemetry.ts",
        devtools: "src/devtools/index.ts",
        plugins: "src/plugins.ts",
        admin: "src/admin.ts",
    },
    format: ["esm", "cjs"],
    platform: "neutral",
    target: "es2020",
    dts: true,
    sourcemap: true,
    clean: true,
    // Framework peers are never bundled.
    deps: { neverBundle: ["react", "react/jsx-runtime", "vue"] },
    // index.ts has named exports AND a default export (CacheEngine) — keep both reachable.
    outputOptions: { exports: "named" },
    // Single source of truth for the version: package.json.
    define: { __VERSION__: JSON.stringify(pkg.version) },
});
