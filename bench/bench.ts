// Browser benchmark: CacheCraft vs idb-keyval, localForage and Dexie.
// Built and run in a real Chrome by bench/run.mjs (`npm run bench`).

import Dexie from "dexie";
import { createStore, get as idbGet, set as idbSet } from "idb-keyval";
import localforage from "localforage";
import { Bench } from "tinybench";
import { CacheEngine } from "../src";

type Result = { name: string; opsPerSec: number; meanMs: number; p99Ms: number; samples: number };

const N_KEYS = 200;
const payload = (i: number) => ({
    id: i,
    name: `Product ${i}`,
    price: i * 1.5,
    tags: ["a", "b", "c"],
    description: "x".repeat(800),
    updatedAt: "2026-11-15T00:00:00.000Z",
});

async function main(): Promise<Result[]> {
    const keys = Array.from({ length: N_KEYS }, (_, i) => `product:${i}`);
    let cursor = 0;
    const nextKey = () => keys[cursor++ % N_KEYS] as string;

    const cc = new CacheEngine({
        dbName: "bench-cc",
        autoCleanup: false,
        persistAccessMetadata: true,
    });
    const ccMem = new CacheEngine({
        dbName: "bench-cc-mem",
        autoCleanup: false,
        memoryCache: { maxEntries: 1000 },
    });
    const idbStore = createStore("bench-idb-keyval", "kv");
    localforage.config({ name: "bench-localforage" });
    const dexie = new Dexie("bench-dexie");
    dexie.version(1).stores({ kv: "" });
    const table = dexie.table("kv");

    // Seed every store with the same data.
    for (const [i, key] of keys.entries()) {
        await cc.set(key, payload(i));
        await ccMem.set(key, payload(i));
        await idbSet(key, payload(i), idbStore);
        await localforage.setItem(key, payload(i));
        await table.put(payload(i), key);
    }

    const bench = new Bench({ time: 800, warmupTime: 200 });
    bench
        .add("get · CacheCraft", async () => void (await cc.get(nextKey())))
        .add("get · CacheCraft + memoryCache", async () => void (await ccMem.get(nextKey())))
        .add("get · idb-keyval", async () => void (await idbGet(nextKey(), idbStore)))
        .add("get · localForage", async () => void (await localforage.getItem(nextKey())))
        .add("get · Dexie", async () => void (await table.get(nextKey())))
        .add("set · CacheCraft", async () => {
            const k = nextKey();
            await cc.set(k, payload(cursor));
        })
        .add(
            "set · idb-keyval",
            async () => void (await idbSet(nextKey(), payload(cursor), idbStore))
        )
        .add(
            "set · localForage",
            async () => void (await localforage.setItem(nextKey(), payload(cursor)))
        )
        .add("set · Dexie", async () => void (await table.put(payload(cursor), nextKey())))
        .add("getMany(50) · CacheCraft", async () => void (await cc.getMany(keys.slice(0, 50))))
        .add("bulkGet(50) · Dexie", async () => void (await table.bulkGet(keys.slice(0, 50))))
        .add(
            "getOrSet (hit) · CacheCraft",
            async () => void (await cc.getOrSet(nextKey(), () => payload(0)))
        );

    await bench.run();
    return bench.tasks.map((t) => {
        const r = t.result as unknown as {
            throughput?: { mean: number };
            latency?: { mean: number; p99: number; samplesCount?: number };
        } & Record<string, unknown>;
        const latency = r.latency ?? { mean: Number(r.mean ?? 0), p99: Number(r.p99 ?? 0) };
        return {
            name: t.name,
            opsPerSec: r.throughput?.mean ?? Number(r.hz ?? 0),
            meanMs: latency.mean,
            p99Ms: latency.p99,
            samples:
                latency.samplesCount ?? Number((r.samples as unknown[] | undefined)?.length ?? 0),
        };
    });
}

main().then(
    (results) => {
        (window as unknown as { __BENCH__: unknown }).__BENCH__ = { ok: true, results };
    },
    (error) => {
        (window as unknown as { __BENCH__: unknown }).__BENCH__ = {
            ok: false,
            error: String(error?.stack ?? error),
        };
    }
);
