import typescript from "@rollup/plugin-typescript";
import dts from "rollup-plugin-dts";

const tsOptions = { tsconfig: "./tsconfig.json", declaration: false, declarationMap: false };

// React is a peer dependency — never bundle it.
const external = ["react", "react/jsx-runtime"];

function bundle(input, name, banner) {
    return [
        {
            input,
            output: [
                { file: `dist/${name}.js`,  format: "esm", sourcemap: true, exports: "named", ...(banner ? { banner } : {}) },
                { file: `dist/${name}.cjs`, format: "cjs", sourcemap: true, exports: "named", ...(banner ? { banner } : {}) },
            ],
            plugins: [typescript(tsOptions)],
            external,
            treeshake: { moduleSideEffects: false },
            // "use client" is a source directive; rollup strips it, so we
            // re-inject it via banner for the React entry below.
            onwarn(warning, warn) {
                if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
                warn(warning);
            },
        },
        {
            input,
            output: [{ file: `dist/${name}.d.ts`, format: "es" }],
            plugins: [dts()],
            external,
        },
    ];
}

export default [
    ...bundle("src/index.ts", "index"),
    ...bundle("src/react.ts", "react", '"use client";'),
];
