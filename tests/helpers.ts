import type { CacheConfig } from "../src";
import { CacheEngine } from "../src";

let counter = 0;
const engines: CacheEngine[] = [];

/** Fresh, isolated engine (unique DB) with background timers off by default. */
export function makeCache(config: CacheConfig = {}): CacheEngine {
    const cache = new CacheEngine({
        dbName: `test-db-${++counter}`,
        autoCleanup: false,
        persistAccessMetadata: false,
        ...config,
    });
    engines.push(cache);
    return cache;
}

export function uniqueDb(): string {
    return `test-db-${++counter}`;
}

export async function destroyAll(): Promise<void> {
    await Promise.all(engines.splice(0).map((e) => e.destroy()));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
