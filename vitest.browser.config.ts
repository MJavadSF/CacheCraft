import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

// Real-browser tests (IndexedDB, OPFS, Web Locks, BroadcastChannel, CompressionStream).
// Locally: CHROME_PATH=/path/to/chrome npm run test:browser
// CI:      npx playwright install --with-deps chromium && npm run test:browser
export default defineConfig({
    define: { __VERSION__: JSON.stringify(pkg.version) },
    test: {
        include: ["tests/browser/**/*.test.ts"],
        testTimeout: 30_000,
        browser: {
            enabled: true,
            headless: true,
            provider: playwright({
                launchOptions: {
                    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
                    args: ["--no-sandbox"],
                },
            }),
            instances: [{ browser: "chromium" }],
        },
    },
});
