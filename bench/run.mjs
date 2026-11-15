// Builds bench/bench.ts for the browser, serves it on localhost (IndexedDB needs
// a real origin) and runs it in Chromium via Playwright. Prints a Markdown table.
//
//   npm run bench                       # Playwright's Chromium
//   CHROME_PATH=/usr/bin/google-chrome npm run bench

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "rolldown";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = `${root}.out`;

await build({
    input: `${root}bench.ts`,
    output: { file: `${out}/bench.js`, format: "iife" },
    platform: "browser",
    transform: { define: { __VERSION__: '"bench"' } },
    logLevel: "silent",
});

const html =
    '<!doctype html><meta charset="utf-8"><title>bench</title><script src="/bench.js"></script>';
const server = createServer(async (req, res) => {
    if (req.url === "/bench.js") {
        res.setHeader("content-type", "text/javascript");
        res.end(await readFile(`${out}/bench.js`));
    } else {
        res.setHeader("content-type", "text/html");
        res.end(html);
    }
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => window.__BENCH__, null, { timeout: 180_000 });
    const result = await page.evaluate(() => window.__BENCH__);
    if (!result.ok) throw new Error(result.error);
    const version = await browser.version();
    console.log(
        `\nChromium ${version} · ${new Date().toISOString().slice(0, 10)} · 200 keys, ~1 KB JSON values\n`
    );
    console.log("| Benchmark | ops/sec | mean (ms) | p99 (ms) |");
    console.log("|---|---:|---:|---:|");
    for (const r of result.results) {
        console.log(
            `| ${r.name} | ${Math.round(r.opsPerSec).toLocaleString("en-US")} | ${r.meanMs.toFixed(3)} | ${r.p99Ms.toFixed(3)} |`
        );
    }
} finally {
    await browser.close();
    server.close();
}
