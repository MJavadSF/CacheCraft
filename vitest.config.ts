import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
    define: { __VERSION__: JSON.stringify(pkg.version) },
    test: {
        environment: "happy-dom",
        include: ["tests/**/*.test.ts"],
        exclude: ["tests/browser/**", "node_modules/**"],
        setupFiles: ["./tests/setup.ts"],
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            // opfs.ts needs a real browser: it is covered by `npm run test:browser`.
            exclude: ["src/env.d.ts", "src/devtools/styles.ts", "src/storage/opfs.ts"],
            reporter: ["text-summary", "lcov"],
            // Floors, not goals: CI fails if coverage regresses below today's level.
            thresholds: { lines: 88, functions: 82, statements: 85, branches: 74 },
        },
    },
});
