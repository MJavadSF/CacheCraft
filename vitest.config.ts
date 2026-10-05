import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
    define: { __VERSION__: JSON.stringify(pkg.version) },
    test: {
        environment: "happy-dom",
        include: ["tests/**/*.test.ts"],
        setupFiles: ["./tests/setup.ts"],
    },
});
