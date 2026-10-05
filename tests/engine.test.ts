import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheEntry, CachePlugin, EvictionPolicy } from "../src";
import { CacheEngine, CacheError, EncryptionError, QuotaExceededError } from "../src";
import { destroyAll, makeCache, sleep, uniqueDb } from "./helpers";

afterEach(async () => {
    await destroyAll();
    vi.restoreAllMocks();
});

describe("basic operations", () => {
    it("sets, gets, checks and removes", async () => {
        const cache = makeCache();
        await cache.set("user:1", { id: 1, name: "علی" });
        expect(await cache.get("user:1")).toEqual({ id: 1, name: "علی" });
        expect(await cache.has("user:1")).toBe(true);
        expect(await cache.remove("user:1")).toBe(true);
        expect(await cache.get("user:1")).toBeNull();
        expect(await cache.remove("user:1")).toBe(false);
    });

    it("rejects values that cannot be serialised instead of storing garbage", async () => {
        const cache = makeCache();
        await expect(cache.set("k", undefined)).rejects.toMatchObject({ code: "INVALID_VALUE" });
        expect(await cache.count()).toBe(0);
    });

    it("tracks size/count incrementally and persists across instances", async () => {
        const dbName = uniqueDb();
        const a = makeCache({ dbName });
        await a.set("a", "x".repeat(100));
        await a.set("b", "y".repeat(50));
        expect(await a.count()).toBe(2);
        const size = await a.size();
        expect(size).toBeGreaterThan(150);
        await a.destroy();

        const b = makeCache({ dbName });
        expect(await b.count()).toBe(2);
        expect(await b.size()).toBe(size);
        expect(await b.get("a")).toBe("x".repeat(100));
    });

    it("expires entries by TTL", async () => {
        const cache = makeCache();
        await cache.set("k", 1, { ttl: 20 });
        expect(await cache.get("k")).toBe(1);
        await sleep(40);
        expect(await cache.get("k")).toBeNull();
        expect(await cache.has("k")).toBe(false);
    });

    it("calls onGet with null on a miss and onSet after a write", async () => {
        const cache = makeCache();
        const onGet = vi.fn();
        const onSet = vi.fn();
        await cache.get("missing", { onGet });
        expect(onGet).toHaveBeenCalledWith("missing", null);
        await cache.set("k", 1, { onSet });
        expect(onSet).toHaveBeenCalledWith("k", 1);
    });
});

describe("compression & encoding", () => {
    it("auto-compresses above the threshold and reports a real compression ratio", async () => {
        const cache = makeCache({ compressionThreshold: 100 });
        const value = { text: "abc".repeat(2000) };
        await cache.set("big", value);
        expect(await cache.get("big")).toEqual(value);
        const stats = await cache.getDetailedStats();
        expect(stats.compressionRatio).toBeGreaterThan(0);
        expect(stats.compressionRatio).toBeLessThan(0.2);
    });

    it("round-trips encode:true", async () => {
        const cache = makeCache();
        await cache.set("k", { fa: "سلام" }, { encode: true });
        expect(await cache.get("k")).toEqual({ fa: "سلام" });
    });
});

describe("encryption", () => {
    it("round-trips plain, compressed and encoded encrypted values", async () => {
        const cache = makeCache({ encryptionKey: "s3cret" });
        await cache.set("plain", { a: 1 }, { encrypt: true });
        await cache.set("zip", { t: "x".repeat(5000) }, { encrypt: true, forceCompress: true });
        await cache.set("enc", { fa: "سلام" }, { encrypt: true, encode: true });
        expect(await cache.get("plain")).toEqual({ a: 1 });
        expect(await cache.get("zip")).toEqual({ t: "x".repeat(5000) });
        expect(await cache.get("enc")).toEqual({ fa: "سلام" });
        expect((await cache.getDetailedStats()).encryptedCount).toBe(3);
    });

    it("encrypts reliably even when set() races the key derivation", async () => {
        // Previously: encrypt:true silently stored PLAINTEXT if the key wasn't ready yet.
        const cache = makeCache({ encryptionKey: "s3cret" });
        await cache.set("k", { secret: true }, { encrypt: true });
        const [result] = await cache.query({});
        const stored = result?.entry as CacheEntry;
        expect(stored.isEncrypted).toBe(true);
        expect(stored.value).toBeInstanceOf(Uint8Array);
    });

    it("refuses encrypt:true without an encryptionKey instead of storing plaintext", async () => {
        const cache = makeCache();
        await expect(cache.set("k", 1, { encrypt: true })).rejects.toBeInstanceOf(EncryptionError);
        expect(await cache.has("k")).toBe(false);
    });

    it("compressed+encrypted payloads are stored as raw bytes (not a JSON number array)", async () => {
        const cache = makeCache({ encryptionKey: "k" });
        const value = { t: "z".repeat(20_000) };
        await cache.set("k", value, { encrypt: true, forceCompress: true });
        expect((await cache.getDetailedStats()).largestEntry?.size).toBeLessThan(500);
    });

    it("still reads the legacy (<=0.4) compressed+encrypted format", async () => {
        const dbName = uniqueDb();
        const cache = makeCache({ dbName, encryptionKey: "k" });
        await cache.ready();
        const { compress, EncryptionManager } = await import("../src");
        const m = new EncryptionManager();
        await m.initialize("k");
        const gz = await compress(JSON.stringify({ legacy: true }));
        const legacyBytes = await m.encrypt(JSON.stringify(Array.from(gz)));
        const now = Date.now();
        const legacy: CacheEntry = {
            value: legacyBytes,
            isEncoded: false,
            isCompressed: true,
            isEncrypted: true,
            createdAt: now,
            lastAccessed: now,
            accessCount: 0,
            size: legacyBytes.byteLength,
        };
        await cache.import({ version: "0.4.0", timestamp: now, entries: { old: legacy } });
        expect(await cache.get("old")).toEqual({ legacy: true });
    });

    it("reads of an encrypted entry without a key fail loudly, not with garbage", async () => {
        const dbName = uniqueDb();
        const writer = makeCache({ dbName, encryptionKey: "k" });
        await writer.set("k", "top secret", { encrypt: true });
        await writer.destroy();
        const reader = makeCache({ dbName });
        await expect(reader.get("k")).rejects.toBeInstanceOf(EncryptionError);
    });

    it("encrypts blobs", async () => {
        const cache = makeCache({ encryptionKey: "k" });
        await cache.setBlob("b", new Blob(["hello blob"]), { encrypt: true });
        const blob = await cache.getBlob("b", "text/plain");
        expect(await blob?.text()).toBe("hello blob");
        expect(blob?.type).toBe("text/plain");
    });
});

describe("getOrSet", () => {
    it("caches the factory result", async () => {
        const cache = makeCache();
        const factory = vi.fn(async () => ({ v: 1 }));
        expect(await cache.getOrSet("k", factory)).toEqual({ v: 1 });
        expect(await cache.getOrSet("k", factory)).toEqual({ v: 1 });
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("treats a cached null as a hit (negative caching)", async () => {
        const cache = makeCache();
        const factory = vi.fn(async () => null);
        await cache.getOrSet("k", factory);
        await cache.getOrSet("k", factory);
        await cache.getOrSet("k", factory);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("shares ONE factory call between concurrent misses (stampede protection)", async () => {
        const cache = makeCache();
        const factory = vi.fn(async () => {
            await sleep(30);
            return "value";
        });
        const results = await Promise.all(
            Array.from({ length: 10 }, () => cache.getOrSet("k", factory))
        );
        expect(results).toEqual(Array(10).fill("value"));
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("serves stale data and refreshes once in the background", async () => {
        const cache = makeCache();
        await cache.set("k", "old", { ttl: 10 });
        await sleep(25);
        const factory = vi.fn(async () => {
            await sleep(20);
            return "new";
        });
        const opts = { staleWhileRevalidate: true, ttlOnRevalidate: 60_000 };
        // Several concurrent readers all get the stale value; the factory runs once.
        const served = await Promise.all([
            cache.getOrSet("k", factory, opts),
            cache.getOrSet("k", factory, opts),
            cache.getOrSet("k", factory, opts),
        ]);
        expect(served).toEqual(["old", "old", "old"]);
        await sleep(80);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(await cache.get("k")).toBe("new");
    });

    it("falls back to a stale value when the factory fails", async () => {
        const cache = makeCache();
        await cache.set("k", "stale", { ttl: 10 });
        await sleep(25);
        const value = await cache.getOrSet(
            "k",
            async () => {
                throw new Error("origin down");
            },
            { fallbackToStale: true }
        );
        expect(value).toBe("stale");
        await expect(
            cache.getOrSet("other", async () => {
                throw new Error("boom");
            })
        ).rejects.toThrow("boom");
    });

    it("still returns the computed value when caching it fails", async () => {
        const onError = vi.fn();
        const cache = makeCache({ onError });
        // `undefined` cannot be cached, but the value must still reach the caller.
        expect(await cache.getOrSet("k", () => undefined as unknown as string)).toBeUndefined();
        expect(onError).toHaveBeenCalled();
    });
});

describe("stale-while-revalidate on get()", () => {
    it("keeps tags and the original TTL when revalidating", async () => {
        const cache = makeCache();
        await cache.set("k", "old", { ttl: 30, tags: ["t1"], priority: 7 });
        await sleep(45);
        const revalidate = vi.fn(async () => "new");
        expect(await cache.get("k", { staleWhileRevalidate: true, revalidate })).toBe("old");
        await sleep(30);
        expect(revalidate).toHaveBeenCalledTimes(1);
        expect(await cache.keysByTag("t1")).toEqual(["k"]);
        const [meta] = await cache.queryMeta({});
        expect(meta?.priority).toBe(7);
        // Previously the refreshed entry lost its TTL and never expired again.
        expect(meta?.expiresAt).toBeDefined();
    });

    it("de-duplicates concurrent revalidations", async () => {
        const cache = makeCache();
        await cache.set("k", "old", { ttl: 10 });
        await sleep(25);
        const revalidate = vi.fn(async () => {
            await sleep(20);
            return "new";
        });
        await Promise.all(
            Array.from({ length: 5 }, () =>
                cache.get("k", { staleWhileRevalidate: true, revalidate })
            )
        );
        await sleep(60);
        expect(revalidate).toHaveBeenCalledTimes(1);
    });
});

describe("namespaces", () => {
    it("clear() only removes the engine's own namespace", async () => {
        const root = makeCache();
        const users = root.namespace("users");
        const posts = root.namespace("posts");
        await users.set("1", "u1");
        await posts.set("1", "p1");
        expect(await users.clear()).toBe(1);
        expect(await users.get("1")).toBeNull();
        expect(await posts.get("1")).toBe("p1");
    });

    it("a namespaced engine only indexes (and budgets) its own keys", async () => {
        const dbName = uniqueDb();
        const a = makeCache({ dbName, namespace: "a" });
        const b = makeCache({ dbName, namespace: "b" });
        await a.set("x", "1");
        await b.set("x", "22");
        await b.set("y", "333");
        await a.destroy();
        const a2 = makeCache({ dbName, namespace: "a" });
        expect(await a2.count()).toBe(1);
        expect(await a2.keys()).toEqual(["x"]);
        expect(await a2.size()).toBe(3); // '"1"' only — b's entries are not counted
    });

    it("eviction in one namespace never deletes another's entries", async () => {
        const dbName = uniqueDb();
        const big = makeCache({ dbName, namespace: "big", maxSize: 10_000 });
        const small = makeCache({ dbName, namespace: "small", maxSize: 50 });
        await big.set("keep", "k".repeat(500));
        for (let i = 0; i < 5; i++) await small.set(`s${i}`, "s".repeat(40));
        expect(await big.get("keep")).toBe("k".repeat(500));
    });
});

describe("tags & query", () => {
    it("invalidates by tag", async () => {
        const cache = makeCache();
        await cache.set("a", 1, { tags: ["x"] });
        await cache.set("b", 2, { tags: ["x", "y"] });
        await cache.set("c", 3, { tags: ["y"] });
        expect(await cache.invalidateByTag("x")).toBe(2);
        expect(await cache.keys()).toEqual(["c"]);
        expect(cache.allTags()).toEqual(["y"]);
        expect(await cache.invalidateByTags(["y", "nope"])).toBe(1);
    });

    it("filters, sorts and paginates", async () => {
        const cache = makeCache();
        for (let i = 1; i <= 5; i++) {
            await cache.set(`user:${i}`, { i }, { tags: ["user"], priority: i });
        }
        await cache.set("other", { o: 1 });
        const res = await cache.query<{ i: number }>({
            tags: ["user"],
            sortBy: "priority",
            sortOrder: "desc",
            limit: 2,
            offset: 1,
        });
        expect(res.map((r) => r.value.i)).toEqual([4, 3]);
    });

    it("pattern matches the un-namespaced key, like keys()", async () => {
        const cache = makeCache({ namespace: "app" });
        await cache.set("user:1", 1);
        await cache.set("post:1", 2);
        expect((await cache.query({ pattern: /^user:/ })).map((r) => r.key)).toEqual(["user:1"]);
        expect(await cache.keys(/^user:/)).toEqual(["user:1"]);
    });

    it("limit: 0 returns nothing", async () => {
        const cache = makeCache();
        await cache.set("a", 1);
        expect(await cache.query({ limit: 0 })).toEqual([]);
    });

    it("sorts by expiresAt even when some entries never expire", async () => {
        const cache = makeCache();
        await cache.set("never1", 1);
        await cache.set("soon", 2, { ttl: 10_000 });
        await cache.set("never2", 3);
        await cache.set("later", 4, { ttl: 60_000 });
        const asc = (await cache.queryMeta({ sortBy: "expiresAt" })).map((m) => m.key);
        expect(asc.slice(0, 2)).toEqual(["soon", "later"]);
    });

    it("queryMeta returns metadata without payloads", async () => {
        const cache = makeCache({ namespace: "ns" });
        await cache.set("k", { big: "x" }, { tags: ["t"] });
        const [m] = await cache.queryMeta({ tags: ["t"] });
        expect(m).toMatchObject({ key: "k", tags: ["t"] });
        expect(m).not.toHaveProperty("value");
    });
});

describe("batch operations", () => {
    it("batchSet writes atomically and reports per-item failures", async () => {
        const cache = makeCache();
        const results = await cache.batchSet([
            { key: "a", value: 1 },
            { key: "bad", value: undefined },
            { key: "c", value: 3, options: { tags: ["n"] } },
        ]);
        expect(results.map((r) => r.success)).toEqual([true, false, true]);
        expect(results[1]?.error).toBeInstanceOf(CacheError);
        expect(await cache.keys()).toEqual(["a", "c"]);
        expect(await cache.keysByTag("n")).toEqual(["c"]);
    });

    it("batchSet runs plugin hooks (validation can no longer be bypassed)", async () => {
        const seen: string[] = [];
        const plugin: CachePlugin = {
            name: "gate",
            beforeSet: (key) => key !== "blocked",
            afterSet: (key) => {
                seen.push(key);
            },
        };
        const cache = makeCache({ plugins: [plugin] });
        const res = await cache.batchSet([
            { key: "ok", value: 1 },
            { key: "blocked", value: 2 },
        ]);
        expect(res.map((r) => r.success)).toEqual([true, false]);
        expect(res[1]?.error).toMatchObject({ code: "PLUGIN_REJECTED" });
        expect(seen).toEqual(["ok"]);
        expect(await cache.has("blocked")).toBe(false);
    });

    it("getMany and batchDelete", async () => {
        const cache = makeCache();
        await cache.batchSet([
            { key: "a", value: 1 },
            { key: "b", value: 2 },
        ]);
        const many = await cache.getMany<number>(["a", "b", "zzz"]);
        expect(Object.fromEntries(many)).toEqual({ a: 1, b: 2, zzz: null });
        const del = await cache.batchDelete(["a", "zzz"]);
        expect(del.map((r) => r.success)).toEqual([true, false]);
        expect(await cache.count()).toBe(1);
    });

    it("batchGet", async () => {
        const cache = makeCache();
        await cache.set("a", 1);
        const res = await cache.batchGet<number>([{ key: "a" }, { key: "b" }]);
        expect(res.map((r) => r.value)).toEqual([1, null]);
    });
});

describe("eviction", () => {
    it("keeps the cache under maxSize (LRU)", async () => {
        const cache = makeCache({ maxSize: 300 });
        for (let i = 0; i < 10; i++) {
            await cache.set(`k${i}`, "x".repeat(60));
            await sleep(2);
        }
        expect(await cache.size()).toBeLessThanOrEqual(300);
        expect(await cache.has("k9")).toBe(true);
        expect(await cache.has("k0")).toBe(false);
        expect(cache.getStats().evictions).toBeGreaterThan(0);
    });

    it("TTL strategy still bounds the cache when entries have no TTL", async () => {
        const cache = makeCache({ maxSize: 300, evictionStrategy: "ttl" });
        for (let i = 0; i < 10; i++) await cache.set(`k${i}`, "x".repeat(60));
        expect(await cache.size()).toBeLessThanOrEqual(300);
    });

    it("honours a custom policy and ignores keys it invents", async () => {
        const policy: EvictionPolicy = {
            name: "custom-test",
            shouldEvict: (entries) => [entries[0]?.key ?? "", "ghost-key"],
        };
        const cache = makeCache({
            maxSize: 50,
            evictionStrategy: "custom",
            evictionPolicy: policy,
        });
        await cache.set("a", "x".repeat(40));
        await cache.set("b", "y".repeat(40));
        expect(cache.getStats().evictions).toBe(1); // "ghost-key" is not counted
    });

    it("passes namespace-free keys to onEvict plugins", async () => {
        const evicted: string[] = [];
        const cache = makeCache({
            namespace: "ns",
            maxSize: 100,
            plugins: [{ name: "spy", onEvict: (keys) => void evicted.push(...keys) }],
        });
        await cache.set("a", "x".repeat(60));
        await sleep(2);
        await cache.set("b", "y".repeat(60));
        expect(evicted).toEqual(["a"]);
    });
});

describe("export / import", () => {
    it("round-trips between engines", async () => {
        const src = makeCache();
        await src.set("a", { n: 1 }, { tags: ["t"] });
        await src.set("b", "two");
        const data = await src.export();
        expect(data.version).toMatch(/^\d+\.\d+\.\d+/);

        const dst = makeCache();
        expect(await dst.import(data)).toBe(2);
        expect(await dst.get("a")).toEqual({ n: 1 });
        expect(await dst.keysByTag("t")).toEqual(["a"]);
    });

    it("rejects malformed entries (they would corrupt size accounting)", async () => {
        const cache = makeCache();
        const bad = { value: "x" } as unknown as CacheEntry;
        await expect(
            cache.import({ version: "x", timestamp: 0, entries: { bad } })
        ).rejects.toMatchObject({ code: "INVALID_ENTRY" });
        expect(
            await cache.import(
                { version: "x", timestamp: 0, entries: { bad } },
                { skipInvalid: true }
            )
        ).toBe(0);
        expect(await cache.size()).toBe(0);
    });
});

describe("cleanup & maintenance", () => {
    it("removes expired entries and emits expire events", async () => {
        const cache = makeCache();
        const expired: string[] = [];
        cache.on("expire", (d) => void expired.push(d.key ?? ""));
        await cache.set("a", 1, { ttl: 5 });
        await cache.set("b", 2);
        await sleep(20);
        expect(await cache.cleanup()).toBe(1);
        expect(expired).toEqual(["a"]);
        expect(await cache.keys()).toEqual(["b"]);
    });

    it("persists buffered access metadata on flush", async () => {
        const dbName = uniqueDb();
        const a = makeCache({
            dbName,
            persistAccessMetadata: true,
            accessMetadataFlushInterval: 60_000,
        });
        await a.set("k", 1);
        await a.get("k");
        await a.get("k");
        await a.flushAccessMetadata();
        await a.destroy();
        const b = makeCache({ dbName });
        const [m] = await b.queryMeta({});
        expect(m?.accessCount).toBe(2);
    });

    it("recovers from a corrupt index/DB drift by healing the index", async () => {
        const cache = makeCache();
        await cache.set("k", 1);
        // Simulate drift: another connection removed the row behind our back.
        const raw = indexedDB.open(
            (cache as unknown as { config: { dbName: string } }).config.dbName
        );
        await new Promise<void>((resolve) => {
            raw.onsuccess = () => {
                const db = raw.result;
                const tx = db.transaction("cache", "readwrite");
                tx.objectStore("cache").delete("k");
                tx.oncomplete = () => {
                    db.close();
                    resolve();
                };
            };
        });
        expect(await cache.get("k")).toBeNull();
        expect(await cache.count()).toBe(0);
    });
});

describe("stats & health", () => {
    it("computes a true running mean for avgAccessTime and hit rate", async () => {
        const cache = makeCache();
        await cache.set("k", 1);
        await cache.get("k");
        await cache.get("k");
        await cache.get("nope");
        const s = cache.getStats();
        expect(s.hits).toBe(2);
        expect(s.misses).toBe(1);
        expect(s.hitRate).toBeCloseTo(2 / 3);
        expect(s.avgAccessTime).toBeGreaterThanOrEqual(0);
    });

    it("getStorageInfo never triggers a persistence prompt", async () => {
        const persist = vi.fn(async () => true);
        vi.stubGlobal("navigator", {
            storage: {
                estimate: async () => ({ usage: 10, quota: 100 }),
                persisted: async () => false,
                persist,
            },
        });
        const info = await makeCache().getStorageInfo();
        expect(persist).not.toHaveBeenCalled();
        expect(info).toMatchObject({ used: 10, total: 100, available: 90, canGrow: false });
        vi.unstubAllGlobals();
    });

    it("reports health", async () => {
        const cache = makeCache();
        await cache.set("k", 1);
        const health = await cache.getHealth();
        expect(health).toMatchObject({ isHealthy: true, dbConnected: true, entryCount: 1 });
    });
});

describe("events & errors", () => {
    it("emits events and supports once/off", async () => {
        const cache = makeCache();
        const sets: string[] = [];
        const once = vi.fn();
        cache.on("set", (d) => void sets.push(d.key ?? ""));
        cache.once("set", once);
        await cache.set("a", 1);
        await cache.set("b", 2);
        expect(sets).toEqual(["a", "b"]);
        expect(once).toHaveBeenCalledTimes(1);
    });

    it("a throwing 'error' listener cannot cause infinite recursion", async () => {
        const cache = makeCache();
        cache.on("error", () => {
            throw new Error("listener bug");
        });
        await expect(cache.set("k", undefined)).rejects.toBeInstanceOf(CacheError);
    });

    it("a throwing onError callback cannot break the engine", async () => {
        const cache = makeCache({
            onError: () => {
                throw new Error("callback bug");
            },
        });
        await expect(cache.set("k", undefined)).rejects.toMatchObject({ code: "INVALID_VALUE" });
        await cache.set("ok", 1);
        expect(await cache.get("ok")).toBe(1);
    });

    it("tells plugins which operation failed", async () => {
        const ops: string[] = [];
        const cache = makeCache({
            plugins: [{ name: "p", onError: (_e, op) => void ops.push(op) }],
        });
        await cache.set("k", undefined).catch(() => undefined);
        expect(ops).toEqual(["set"]);
    });

    it("exports QuotaExceededError", () => {
        expect(new QuotaExceededError()).toMatchObject({ code: "QUOTA_EXCEEDED" });
    });
});

describe("SSR safety", () => {
    it("fails with a clear error (not a crash) when IndexedDB is missing", async () => {
        vi.stubGlobal("indexedDB", undefined);
        const cache = new CacheEngine({ autoCleanup: false, persistAccessMetadata: false });
        await expect(cache.get("k")).rejects.toMatchObject({ code: "UNSUPPORTED_ENV" });
        vi.unstubAllGlobals();
    });
});

describe("cross-tab sync", () => {
    it("propagates set/delete between engines of the same namespace only", async () => {
        const dbName = uniqueDb();
        const a = makeCache({ dbName, enableSync: true });
        const b = makeCache({ dbName, enableSync: true });
        const otherNs = makeCache({ dbName, enableSync: true, namespace: "other" });
        await Promise.all([a.ready(), b.ready(), otherNs.ready()]);

        await otherNs.set("x", "other-value");
        await a.set("x", "from-a");
        await sleep(60);
        expect(await b.get("x")).toBe("from-a"); // synced into b's index
        expect(await otherNs.get("x")).toBe("other-value");

        // A delete in `a` must NOT delete the same key name in another namespace.
        await a.remove("x");
        await sleep(60);
        expect(await b.has("x")).toBe(false);
        expect(await otherNs.get("x")).toBe("other-value");
    });

    it("never broadcasts values (non-cloneable data cannot break set())", async () => {
        const dbName = uniqueDb();
        const a = makeCache({ dbName, enableSync: true });
        makeCache({ dbName, enableSync: true });
        // A function inside the value is dropped by JSON but would throw DataCloneError in postMessage.
        await expect(a.set("k", { fn: () => 1, n: 1 })).resolves.toBeUndefined();
        expect(await a.get("k")).toEqual({ n: 1 });
    });

    it("clear() in one tab empties the other tab's index without wiping other namespaces", async () => {
        const dbName = uniqueDb();
        const a = makeCache({ dbName, enableSync: true, namespace: "a" });
        const a2 = makeCache({ dbName, enableSync: true, namespace: "a" });
        const keep = makeCache({ dbName, enableSync: true, namespace: "keep" });
        await Promise.all([a.ready(), a2.ready()]);
        await keep.set("k", "safe");
        await a.set("k", 1);
        await sleep(60);
        await a.clear();
        await sleep(60);
        expect(await a2.count()).toBe(0);
        expect(await keep.get("k")).toBe("safe");
    });
});

describe("lifecycle", () => {
    it("destroy() stops timers and is idempotent", async () => {
        const cache = new CacheEngine({
            dbName: uniqueDb(),
            autoCleanup: true,
            cleanupInterval: 10,
            persistAccessMetadata: true,
            accessMetadataFlushInterval: 10,
        });
        await cache.set("k", 1);
        await cache.destroy();
        await expect(cache.destroy()).resolves.toBeUndefined();
    });

    it("namespace() children inherit runtime plugins", async () => {
        const cache = makeCache();
        const seen: string[] = [];
        cache.use({ name: "spy", afterSet: (k) => void seen.push(k) });
        const child = cache.namespace("child");
        await child.set("k", 1);
        await child.destroy();
        expect(seen).toEqual(["k"]);
    });
});
