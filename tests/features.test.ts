import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
    type CacheEngine,
    createTypedCache,
    MemoryAdapter,
    parseDuration,
    parseSize,
    QuotaExceededError,
    type StandardSchemaV1,
    type StorageAdapter,
    TimeoutError,
} from "../src";
import { destroyAll, makeCache, sleep, uniqueDb } from "./helpers";

afterEach(async () => {
    vi.useRealTimers();
    await destroyAll();
});

describe("durations and sizes", () => {
    it("parses human-friendly values", () => {
        expect(parseDuration(1500)).toBe(1500);
        expect(parseDuration("500ms")).toBe(500);
        expect(parseDuration("30s")).toBe(30_000);
        expect(parseDuration("5m")).toBe(300_000);
        expect(parseDuration("1h30m")).toBe(5_400_000);
        expect(parseDuration("1h 30m")).toBe(5_400_000);
        expect(parseDuration("2d")).toBe(172_800_000);
        expect(parseDuration("1w")).toBe(604_800_000);
        expect(() => parseDuration("soon")).toThrow();
        expect(() => parseDuration("5x")).toThrow();
        expect(parseSize("1KB")).toBe(1024);
        expect(parseSize("1.5MB")).toBe(1.5 * 1024 * 1024);
        expect(() => parseSize("big")).toThrow();
    });

    it("accepts them in options and config", async () => {
        const cache = makeCache({ defaultTTL: "1h", maxSize: "1MB" });
        await cache.set("a", 1);
        await cache.set("b", 1, { ttl: "10s" });
        const a = await cache.getWithMeta("a");
        const b = await cache.getWithMeta("b");
        expect(a?.info.ttlRemaining).toBeGreaterThan(3_500_000);
        expect(b?.info.ttlRemaining).toBeLessThanOrEqual(10_000);
    });

    it("ttlJitter shortens TTLs randomly within the bound", async () => {
        const cache = makeCache();
        for (let i = 0; i < 20; i++) await cache.set(`k${i}`, i, { ttl: 100_000, ttlJitter: 0.5 });
        const ttls = (await cache.queryMeta()).map((m) => (m.expiresAt as number) - m.createdAt);
        expect(Math.min(...ttls)).toBeGreaterThanOrEqual(50_000);
        expect(Math.max(...ttls)).toBeLessThanOrEqual(100_000);
        expect(new Set(ttls).size).toBeGreaterThan(1);
    });
});

describe("read helpers", () => {
    it("peek() has no side effects", async () => {
        const cache = makeCache();
        await cache.set("k", 1, { ttl: 10 });
        const before = cache.getStats();
        expect(await cache.peek("k")).toBe(1);
        expect(cache.getStats().hits).toBe(before.hits);
        await sleep(20);
        expect(await cache.peek("k")).toBeNull();
        expect(await cache.peek("k", { allowStale: true })).toBe(1); // not deleted
    });

    it("getWithMeta() returns age, TTL and tags", async () => {
        const cache = makeCache();
        await cache.set("k", { a: 1 }, { ttl: "1m", tags: ["t"], priority: 3 });
        const res = await cache.getWithMeta<{ a: number }>("k");
        expect(res?.value).toEqual({ a: 1 });
        expect(res?.info).toMatchObject({ key: "k", tags: ["t"], priority: 3, stale: false });
        expect(res?.info.ttlRemaining).toBeGreaterThan(0);
    });

    it("touch() extends, re-arms or removes the expiry", async () => {
        const cache = makeCache();
        await cache.set("k", 1, { ttl: 50 });
        expect(await cache.touch("k", "1h")).toBe(true);
        await sleep(70);
        expect(await cache.get("k")).toBe(1);
        expect(await cache.touch("k", null)).toBe(true);
        expect((await cache.getWithMeta("k"))?.info.expiresAt).toBeUndefined();
        expect(await cache.touch("missing")).toBe(false);
    });

    it("touch() without a ttl re-arms the original lifetime", async () => {
        const cache = makeCache();
        await cache.set("k", 1, { ttl: 60 });
        await sleep(40);
        await cache.touch("k");
        await sleep(40);
        expect(await cache.get("k")).toBe(1);
    });
});

describe("update()", () => {
    it("serialises concurrent read-modify-write per key", async () => {
        const cache = makeCache();
        await cache.set("counter", 0);
        await Promise.all(
            Array.from({ length: 25 }, () => cache.update<number>("counter", (n) => (n ?? 0) + 1))
        );
        expect(await cache.get("counter")).toBe(25);
    });

    it("keeps TTL, tags and encryption when no options are given; undefined deletes", async () => {
        const cache = makeCache({ encryptionKey: "pw", kdfIterations: 1000 });
        await cache.set("k", { n: 1 }, { ttl: "1h", tags: ["x"], encrypt: true });
        await cache.update<{ n: number }>("k", (v) => ({ n: (v?.n ?? 0) + 1 }));
        const res = await cache.getWithMeta<{ n: number }>("k");
        expect(res?.value).toEqual({ n: 2 });
        expect(res?.info.tags).toEqual(["x"]);
        expect(res?.info.isEncrypted).toBe(true);
        expect(res?.info.ttlRemaining).toBeGreaterThan(3_000_000);
        await cache.update("k", () => undefined);
        expect(await cache.has("k")).toBe(false);
    });
});

describe("invalidation", () => {
    it("invalidateByPattern / invalidateByTags remove in one go", async () => {
        const cache = makeCache();
        await cache.batchSet([
            { key: "user:1", value: 1, options: { tags: ["users"] } },
            { key: "user:2", value: 2, options: { tags: ["users", "vip"] } },
            { key: "post:1", value: 3, options: { tags: ["posts"] } },
        ]);
        expect(await cache.invalidateByPattern(/^user:/)).toBe(2);
        expect(await cache.keys()).toEqual(["post:1"]);
        expect(await cache.invalidateByTags(["posts", "nope"])).toBe(1);
        expect(await cache.count()).toBe(0);
    });

    it("query supports tagMode 'all' and sorting by key", async () => {
        const cache = makeCache();
        await cache.set("b", 1, { tags: ["x", "y"] });
        await cache.set("a", 1, { tags: ["x", "y"] });
        await cache.set("c", 1, { tags: ["x"] });
        const res = await cache.queryMeta({ tags: ["x", "y"], tagMode: "all", sortBy: "key" });
        expect(res.map((m) => m.key)).toEqual(["a", "b"]);
    });
});

describe("budgets", () => {
    it("maxEntries evicts down to the eviction target", async () => {
        const cache = makeCache({ maxEntries: 10, evictionTarget: 0.8 });
        for (let i = 0; i < 11; i++) {
            await cache.set(`k${i}`, i);
            await sleep(1);
        }
        expect(await cache.count()).toBe(8);
        expect(await cache.has("k10")).toBe(true);
        expect(await cache.has("k0")).toBe(false);
    });

    it("size budgets evict to the target, not just under the limit", async () => {
        const cache = makeCache({ maxSize: 1000, evictionTarget: 0.5 });
        for (let i = 0; i < 9; i++) {
            await cache.set(`k${i}`, "x".repeat(98)); // 100 bytes each
            await sleep(1);
        }
        expect(await cache.size()).toBe(900);
        await cache.set("k9", "x".repeat(198)); // 1100 > 1000 → down to ≤ 500
        expect(await cache.size()).toBeLessThanOrEqual(500);
        expect(await cache.has("k9")).toBe(true);
    });

    it("per-tag quotas only evict entries of that tag", async () => {
        const cache = makeCache({ tagQuotas: { images: { maxEntries: 2 } } });
        await cache.set("other", 1);
        for (let i = 0; i < 4; i++) {
            await cache.set(`img${i}`, i, { tags: ["images"] });
            await sleep(1);
        }
        expect(await cache.keysByTag("images")).toEqual(["img2", "img3"]);
        expect(await cache.has("other")).toBe(true);
    });

    it("custom policies without rank() fall back to LRU order for count budgets", async () => {
        const cache = makeCache({
            maxEntries: 2,
            evictionTarget: 1,
            evictionStrategy: "custom",
            evictionPolicy: { name: "never-by-size", shouldEvict: () => [] },
        });
        await cache.set("a", 1);
        await sleep(1);
        await cache.set("b", 1);
        await sleep(1);
        await cache.set("c", 1);
        expect(await cache.keys()).toEqual(["b", "c"]);
    });
});

describe("compression", () => {
    it("keeps incompressible data uncompressed (minRatio)", async () => {
        const cache = makeCache({ compression: { threshold: 100 } });
        const random = Array.from({ length: 2000 }, () => Math.random().toString(36).slice(2)).join(
            ""
        );
        await cache.set("random", random);
        await cache.set("text", "abc".repeat(2000));
        const metas = Object.fromEntries((await cache.queryMeta()).map((m) => [m.key, m]));
        expect(metas.text?.isCompressed).toBe(true);
        expect(metas.text?.compression).toBe("gzip");
        expect(metas.random?.size).toBeGreaterThan(0);
        expect(await cache.get("text")).toBe("abc".repeat(2000));
    });

    it("supports deflate-raw and can be disabled", async () => {
        const dbName = uniqueDb();
        const raw = makeCache({ dbName, compression: { algorithm: "deflate-raw", threshold: 10 } });
        await raw.set("k", "z".repeat(5000));
        expect((await raw.queryMeta())[0]?.compression).toBe("deflate-raw");
        expect(await raw.get("k")).toBe("z".repeat(5000));
        const off = makeCache({ compression: false });
        await off.set("k", "z".repeat(50_000));
        expect((await off.queryMeta())[0]?.isCompressed).toBe(false);
    });
});

describe("getOrSet", () => {
    it("passes a context with signal/attempt/stale to the factory", async () => {
        const cache = makeCache();
        await cache.set("k", "old", { ttl: 10 });
        await sleep(20);
        const factory = vi.fn(
            async (ctx: { attempt: number; stale: string | undefined; signal: AbortSignal }) => {
                expect(ctx.signal).toBeInstanceOf(AbortSignal);
                return `${ctx.stale}->new#${ctx.attempt}`;
            }
        );
        expect(await cache.getOrSet("k", factory, { fallbackToStale: true })).toBe("old->new#1");
    });

    it("retries with backoff", async () => {
        const cache = makeCache();
        let calls = 0;
        const value = await cache.getOrSet(
            "k",
            async () => {
                calls++;
                if (calls < 3) throw new Error("flaky");
                return "ok";
            },
            { retry: { retries: 3, delay: 1 } }
        );
        expect(value).toBe("ok");
        expect(calls).toBe(3);
    });

    it("stops retrying when shouldRetry says so", async () => {
        const cache = makeCache();
        let calls = 0;
        await expect(
            cache.getOrSet(
                "k",
                async () => {
                    calls++;
                    throw new Error("fatal");
                },
                { retry: { retries: 5, delay: 1, shouldRetry: () => false } }
            )
        ).rejects.toThrow("fatal");
        expect(calls).toBe(1);
    });

    it("times out and aborts the factory signal", async () => {
        const cache = makeCache();
        let aborted = false;
        await expect(
            cache.getOrSet(
                "k",
                ({ signal }) =>
                    new Promise((resolve) => {
                        signal.addEventListener("abort", () => {
                            aborted = true;
                        });
                        setTimeout(() => resolve("late"), 200);
                    }),
                { timeout: 20 }
            )
        ).rejects.toBeInstanceOf(TimeoutError);
        expect(aborted).toBe(true);
    });

    it("a caller's AbortSignal only rejects that caller; others still get the value", async () => {
        const cache = makeCache();
        const controller = new AbortController();
        let calls = 0;
        const factory = async (): Promise<string> => {
            calls++;
            await sleep(30);
            return "v";
        };
        const a = cache.getOrSet("k", factory, { signal: controller.signal });
        const b = cache.getOrSet("k", factory);
        controller.abort();
        await expect(a).rejects.toBeDefined();
        expect(await b).toBe("v");
        expect(calls).toBe(1);
    });

    it("aborts the factory when every waiting caller gave up", async () => {
        const cache = makeCache();
        const controller = new AbortController();
        let factorySignal: AbortSignal | undefined;
        const p = cache.getOrSet(
            "k",
            ({ signal }) => {
                factorySignal = signal;
                return new Promise<string>((r) => setTimeout(() => r("v"), 100));
            },
            { signal: controller.signal }
        );
        await sleep(5);
        controller.abort();
        await expect(p).rejects.toBeDefined();
        expect(factorySignal?.aborted).toBe(true);
    });

    it("forceRefresh bypasses a fresh value", async () => {
        const cache = makeCache();
        await cache.set("k", "cached");
        expect(await cache.getOrSet("k", () => "fresh", { forceRefresh: true })).toBe("fresh");
        expect(await cache.get("k")).toBe("fresh");
    });

    it("maxStale limits how old a served stale value may be", async () => {
        const cache = makeCache();
        await cache.set("k", "old", { ttl: 5 });
        await sleep(40);
        await expect(
            cache.getOrSet(
                "k",
                () => {
                    throw new Error("down");
                },
                { fallbackToStale: true, maxStale: 10 }
            )
        ).rejects.toThrow("down");
        await cache.set("k", "old", { ttl: 5 });
        await sleep(15);
        expect(
            await cache.getOrSet(
                "k",
                () => {
                    throw new Error("down");
                },
                { fallbackToStale: true, maxStale: "1m" }
            )
        ).toBe("old");
    });

    it("background SWR refresh keeps tags and the original TTL", async () => {
        const cache = makeCache();
        await cache.set("k", 1, { ttl: 30, tags: ["t"] });
        await sleep(40);
        expect(
            await cache.getOrSet("k", () => 2, { staleWhileRevalidate: true, ttl: 30, tags: ["t"] })
        ).toBe(1);
        await sleep(10);
        expect(await cache.get("k")).toBe(2);
        expect(await cache.keysByTag("t")).toEqual(["k"]);
    });
});

describe("memory tier", () => {
    it("serves repeated reads from memory and stays coherent with writes", async () => {
        const cache = makeCache({ memoryCache: { maxEntries: 10 } });
        await cache.set("k", { a: 1 });
        await cache.get("k");
        await cache.get("k");
        expect(cache.getStats().memoryHits).toBe(2);
        await cache.set("k", { a: 2 });
        expect(await cache.get("k")).toEqual({ a: 2 });
        await cache.remove("k");
        expect(await cache.get("k")).toBeNull();
    });

    it("respects expiry and clone mode", async () => {
        const cache = makeCache({ memoryCache: { clone: true } });
        const value = { list: [1] };
        await cache.set("k", value, { ttl: 20 });
        value.list.push(2); // mutating the original doesn't leak in
        const read = (await cache.get<{ list: number[] }>("k")) as { list: number[] };
        expect(read.list).toEqual([1]);
        read.list.push(3); // nor does mutating what we got
        expect(await cache.get("k")).toEqual({ list: [1] });
        await sleep(30);
        expect(await cache.get("k")).toBeNull();
    });
});

describe("schemas and schema versions", () => {
    const numberSchema: StandardSchemaV1<unknown, number> = {
        "~standard": {
            version: 1,
            vendor: "test",
            validate: (v) =>
                typeof v === "number" ? { value: v } : { issues: [{ message: "not a number" }] },
        },
    };

    it("treats values failing the schema as a miss (and deletes them)", async () => {
        const errors: string[] = [];
        const cache = makeCache({ onError: (e) => void errors.push(e.message) });
        await cache.set("n", "oops");
        expect(await cache.get("n", { schema: numberSchema })).toBeNull();
        expect(await cache.has("n")).toBe(false);
        expect(errors[0]).toContain("not a number");
        expect(await cache.getOrSet("n", () => 5, { schema: numberSchema })).toBe(5);
    });

    it("migrates values written under an older schemaVersion", async () => {
        const dbName = uniqueDb();
        const v1 = makeCache({ dbName, schemaVersion: 1 });
        await v1.set("user", { name: "Ada Lovelace" }, { tags: ["u"] });
        const v2 = makeCache({
            dbName,
            schemaVersion: 2,
            migrate: (value, from) => {
                const old = value as { name: string };
                const [first, last] = old.name.split(" ");
                return from === 1 ? { first, last } : undefined;
            },
        });
        expect(await v2.get("user")).toEqual({ first: "Ada", last: "Lovelace" });
        expect((await v2.queryMeta())[0]).toMatchObject({ schemaVersion: 2, tags: ["u"] });
    });

    it("drops entries from other schema versions when there is no migrate()", async () => {
        const dbName = uniqueDb();
        await makeCache({ dbName, schemaVersion: 1 }).set("k", 1);
        const v2 = makeCache({ dbName, schemaVersion: 2 });
        expect(await v2.get("k")).toBeNull();
    });
});

describe("quota recovery", () => {
    it("evicts and retries once when the storage reports QuotaExceeded", async () => {
        const memory = new MemoryAdapter(uniqueDb());
        let failNext = false;
        const adapter: StorageAdapter = {
            ...Object.fromEntries(
                (
                    [
                        "loadMeta",
                        "getMeta",
                        "get",
                        "clear",
                        "getSystem",
                        "initSystem",
                        "close",
                    ] as const
                ).map((m) => [m, (memory[m] as (...a: unknown[]) => unknown).bind(memory)])
            ),
            kind: "flaky",
            persistent: false,
            write: async (ns, ops) => {
                if (failNext && ops.some((o) => o.type === "put")) {
                    failNext = false;
                    throw new QuotaExceededError();
                }
                return memory.write(ns, ops);
            },
        } as StorageAdapter;
        const cache = makeCache({ storage: adapter });
        for (let i = 0; i < 5; i++) {
            await cache.set(`k${i}`, "x".repeat(100));
            await sleep(1);
        }
        failNext = true;
        await cache.set("new", "y");
        expect(await cache.get("new")).toBe("y");
        expect(await cache.count()).toBeLessThan(6);
        expect(cache.getStats().evictions).toBeGreaterThan(0);
    });
});

describe("export / import", () => {
    it("round-trips through JSON, including binary and encrypted entries across databases", async () => {
        const source = makeCache({
            encryptionKey: "pw",
            kdfIterations: 1000,
            compression: { threshold: 10 },
        });
        await source.set("plain", { a: 1 }, { tags: ["t"] });
        await source.set("zipped", "q".repeat(500));
        await source.set("secret", { s: 1 }, { encrypt: true });
        await source.setBlob("blob", new Blob([new Uint8Array([9, 8, 7])], { type: "image/png" }));

        const json = await source.exportJSON();
        const parsed = JSON.parse(json);
        expect(parsed).toMatchObject({ format: "cachecraft", formatVersion: 2 });

        // Different database → different salt → the entry must be re-encrypted.
        const target = makeCache({ encryptionKey: "pw", kdfIterations: 1000 });
        expect(await target.importJSON(json)).toBe(4);
        expect(await target.get("plain")).toEqual({ a: 1 });
        expect(await target.get("zipped")).toBe("q".repeat(500));
        expect(await target.get("secret")).toEqual({ s: 1 });
        const blob = await target.getBlob("blob");
        expect(blob?.type).toBe("image/png");
        expect(Array.from(new Uint8Array((await blob?.arrayBuffer()) as ArrayBuffer))).toEqual([
            9, 8, 7,
        ]);
        expect(await target.keysByTag("t")).toEqual(["plain"]);
    });

    it("decrypt: true exports plaintext that another key can import (and re-encrypt)", async () => {
        const source = makeCache({ encryptionKey: "a", kdfIterations: 1000 });
        await source.set("secret", { s: 1 }, { encrypt: true });
        const data = await source.export({ decrypt: true });
        expect(data.entries[0]?.meta.isEncrypted).toBe(false);
        const target = makeCache({ encryptionKey: "b", kdfIterations: 1000 });
        await target.import(data, { encrypt: true });
        expect(await target.get("secret")).toEqual({ s: 1 });
        expect((await target.queryMeta())[0]?.isEncrypted).toBe(true);
    });

    it("skips existing keys unless overwrite, and validates entries", async () => {
        const a = makeCache();
        await a.set("k", 1);
        const data = await a.export();
        const b = makeCache();
        await b.set("k", 2);
        expect(await b.import(data)).toBe(0);
        expect(await b.get("k")).toBe(2);
        expect(await b.import(data, { overwrite: true })).toBe(1);
        expect(await b.get("k")).toBe(1);
        const bad = { ...data, entries: [{ key: "x", meta: { size: Number.NaN }, payload: "1" }] };
        await expect(b.import(bad as never)).rejects.toMatchObject({ code: "INVALID_ENTRY" });
        expect(await b.import(bad as never, { skipInvalid: true })).toBe(0);
    });

    it("accepts the ≤0.5 export shape", async () => {
        const cache = makeCache();
        const n = await cache.import({
            version: "0.5.0",
            timestamp: Date.now(),
            entries: {
                k: {
                    value: JSON.stringify({ a: 1 }),
                    isEncoded: false,
                    isCompressed: false,
                    createdAt: Date.now(),
                    lastAccessed: Date.now(),
                    size: 7,
                },
            },
        } as never);
        expect(n).toBe(1);
        expect(await cache.get("k")).toEqual({ a: 1 });
    });
});

describe("key rotation", () => {
    it("re-encrypts every encrypted entry with the new key", async () => {
        const dbName = uniqueDb();
        const cache = makeCache({ dbName, encryptionKey: "old", kdfIterations: 1000 });
        await cache.set("a", 1, { encrypt: true });
        await cache.set("b", "x".repeat(20_000), { encrypt: true });
        await cache.set("plain", 3);
        expect(await cache.rotateKey("new")).toBe(2);
        await cache.destroy();

        const withNewKey = makeCache({ dbName, encryptionKey: "new", kdfIterations: 1000 });
        expect(await withNewKey.get("a")).toBe(1);
        expect(await withNewKey.get("b")).toBe("x".repeat(20_000));
        expect(await withNewKey.get("plain")).toBe(3);

        const withOldKey = makeCache({ dbName, encryptionKey: "old", kdfIterations: 1000 });
        await expect(withOldKey.get("a")).rejects.toMatchObject({ code: "ENCRYPTION_ERROR" });
    });

    it("decryptionKeys keep old entries readable", async () => {
        const dbName = uniqueDb();
        await makeCache({ dbName, encryptionKey: "old", kdfIterations: 1000 }).set("a", 1, {
            encrypt: true,
        });
        const cache = makeCache({
            dbName,
            encryptionKey: "new",
            decryptionKeys: ["old"],
            kdfIterations: 1000,
        });
        expect(await cache.get("a")).toBe(1);
    });

    it("accepts a CryptoKey", async () => {
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
            "encrypt",
            "decrypt",
        ]);
        const cache = makeCache({ encryptionKey: key });
        await cache.set("k", { v: 1 }, { encrypt: true });
        expect(await cache.get("k")).toEqual({ v: 1 });
    });
});

describe("observability", () => {
    it("emits operation events and keeps latency percentiles", async () => {
        const cache = makeCache();
        const ops: string[] = [];
        cache.on("operation", (e) => void ops.push(String(e.metadata?.operation)));
        await cache.set("k", 1);
        await cache.get("k");
        await cache.getOrSet("k2", () => 2);
        expect(ops).toEqual(expect.arrayContaining(["set", "get", "getOrSet"]));
        const stats = await cache.getDetailedStats();
        expect(stats.latency.get?.count).toBe(1);
        expect(stats.latency.set?.p95).toBeGreaterThanOrEqual(0);
    });

    it("on() returns an unsubscribe function", async () => {
        const cache = makeCache();
        let n = 0;
        const off = cache.on("set", () => n++);
        await cache.set("a", 1);
        off();
        await cache.set("b", 1);
        expect(n).toBe(1);
    });
});

describe("lifecycle", () => {
    it("rejects operations after destroy()", async () => {
        const cache = makeCache();
        await cache.set("k", 1);
        await cache.destroy();
        expect(cache.isDestroyed).toBe(true);
        await expect(cache.get("k")).rejects.toMatchObject({ code: "DESTROYED" });
    });

    it("refresh() reloads the index from storage", async () => {
        const dbName = uniqueDb();
        const a = makeCache({ dbName, enableSync: false });
        const b = makeCache({ dbName, enableSync: false });
        await b.ready();
        await a.set("x", 1);
        expect(await b.count()).toBe(0);
        await b.refresh();
        expect(await b.count()).toBe(1);
    });
});

describe("typed facade", () => {
    it("types keys and values", async () => {
        type Schema = { [k: `user:${string}`]: { name: string }; settings: { dark: boolean } };
        const cache = createTypedCache<Schema>(makeCache());
        await cache.set("user:1", { name: "Ada" });
        await cache.set("settings", { dark: true });
        const user = await cache.get("user:1");
        expectTypeOf(user).toEqualTypeOf<{ name: string } | null>();
        expect(user).toEqual({ name: "Ada" });
        // @ts-expect-error wrong value type for the key
        await cache.set("settings", { dark: "yes" }).catch(() => undefined);
        expectTypeOf(cache.engine).toEqualTypeOf<CacheEngine>();
    });
});
