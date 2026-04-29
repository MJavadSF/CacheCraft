import typescript from "@rollup/plugin-typescript";
import dts from "rollup-plugin-dts";

const input = "src/index.ts";
const tsOptions = { tsconfig: "./tsconfig.json", declaration: false };

export default [
    // ESM + CJS bundles
    {
        input,
        output: [
            {
                file: "dist/index.js",
                format: "esm",
                sourcemap: true,
                // Explicit ESM entry for bundlers (Vite, webpack 5, esbuild)
                exports: "named",
            },
            {
                file: "dist/index.cjs",
                format: "cjs",
                sourcemap: true,
                exports: "named",
            },
        ],
        plugins: [typescript(tsOptions)],
        external: [],
        // Preserve module structure for better tree-shaking
        treeshake: {
            moduleSideEffects: false,
        },
    },
    // Type declarations
    {
        input,
        output: [{ file: "dist/index.d.ts", format: "es" }],
        plugins: [dts()],
    },
];
