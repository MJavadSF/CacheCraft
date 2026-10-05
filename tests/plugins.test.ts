import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CacheAdminPanel,
    CacheMonitor,
    CompressionOptimizerPlugin,
    MetricsPlugin,
    PersistencePlugin,
    PrefetchPlugin,
    RateLimiterPlugin,
    TagManagerPlugin,
    TTLRefreshPlugin,
    ValidationPlugin,
    WarmupPlugin,
} from "../src";
import { destroyAll, makeCache, sleep } from "./helpers";

afterEach(async () => {
    await destroyAll();
    localStorage.clear();
});

describe("TTLRefreshPlugin", () => {
    it("slides the expiry on access and persists it", async () => {
        const cache = makeCache({ plugins: [new TTLRefreshPlugin(120)] });
        await cache.set("k", 1, { ttl: 60 });
        // Keep reading every 40ms: without sliding, the entry would die at 60ms.
        for (let i = 0; i < 5; i++) {
            await sleep(40);
            expect(await cache.get("k")).toBe(1);
        }
        await sleep(200);
        expect(await cache.get("k")).toBeNull();
    });

    it("does not give a TTL to entries that never expire", async () => {
        const cache = makeCache({ plugins: [new TTLRefreshPlugin(50)] });
        await cache.set("k", 1);
        await cache.get("k");
        const [m] = await cache.queryMeta({});
        expect(m?.expiresAt).toBeUndefined();
    });
});

describe("CompressionOptimizerPlugin", () => {
    it("forces compression above its threshold even when set() got no options", async () => {
        const cache = makeCache({
            compressionThreshold: 10_000_000,
            plugins: [new CompressionOptimizerPlugin(100)],
        });
        await cache.set("k", { t: "a".repeat(2000) });
        const [m] = await cache.queryMeta({});
        expect(m?.isCompressed).toBe(true);
        expect(await cache.get("k")).toEqual({ t: "a".repeat(2000) });
    });
});

describe("PrefetchPlugin", () => {
    it("stores related values returned by the loader (object form)", async () => {
        const prefetch = new PrefetchPlugin();
        const loader = vi.fn(async () => ({ "post:2": "two", "post:3": "three" }));
        prefetch.addPrefetchRule("post:1", ["post:2", "post:3"], loader);
        const cache = makeCache({ plugins: [prefetch] });
        await cache.set("post:1", "one");
        await cache.get("post:1");
        await sleep(50);
        expect(await cache.get("post:2")).toBe("two");
        expect(await cache.get("post:3")).toBe("three");
        // Everything is cached now → no second load.
        await cache.get("post:1");
        await sleep(30);
        expect(loader).toHaveBeenCalledTimes(1);
    });

    it("supports array results aligned with the keys", async () => {
        const prefetch = new PrefetchPlugin();
        prefetch.addPrefetchRule("a", ["b", "c"], async () => [10, 20]);
        const cache = makeCache({ plugins: [prefetch] });
        await cache.set("a", 1);
        await cache.get("a");
        await sleep(50);
        expect(await cache.get("b")).toBe(10);
        expect(await cache.get("c")).toBe(20);
    });

    it("swallows loader failures", async () => {
        const prefetch = new PrefetchPlugin();
        prefetch.addPrefetchRule("a", ["b"], async () => {
            throw new Error("nope");
        });
        const cache = makeCache({ plugins: [prefetch] });
        await cache.set("a", 1);
        await expect(cache.get("a")).resolves.toBe(1);
        await sleep(30);
    });
});

describe("TagManagerPlugin", () => {
    it("tracks tags and forgets them on overwrite / delete / evict / clear", async () => {
        const tags = new TagManagerPlugin();
        const cache = makeCache({ plugins: [tags], maxSize: 200 });
        await cache.set("a", 1, { tags: ["x"] });
        await cache.set("a", 1, { tags: ["y"] }); // overwrite with other tags
        expect(tags.getKeysWithTag("x")).toEqual([]);
        expect(tags.getKeysWithTag("y")).toEqual(["a"]);
        await cache.remove("a");
        expect(tags.getAllTags()).toEqual([]);

        await cache.set("b", "x".repeat(150), { tags: ["t"] });
        await sleep(2);
        await cache.set("c", "y".repeat(150), { tags: ["t2"] }); // evicts b
        expect(tags.getKeysWithTag("t")).toEqual([]);
        await cache.clear();
        expect(tags.getAllTags()).toEqual([]);
    });
});

describe("ValidationPlugin", () => {
    it("rejects invalid values, also with a global regex, also in batchSet", async () => {
        const v = new ValidationPlugin();
        v.addValidator(/^user:/g, (value: { id?: number }) => typeof value.id === "number");
        const cache = makeCache({ plugins: [v] });
        for (let i = 0; i < 3; i++) {
            await expect(cache.set(`user:${i}`, { id: "bad" })).rejects.toMatchObject({
                code: "VALIDATION_FAILED",
            });
        }
        await cache.set("user:ok", { id: 1 });
        const res = await cache.batchSet([{ key: "user:bad", value: { id: "x" } }]);
        expect(res[0]?.success).toBe(false);
        expect(await cache.keys()).toEqual(["user:ok"]);
    });
});

describe("RateLimiterPlugin", () => {
    it("limits per key and resets", async () => {
        const rl = new RateLimiterPlugin(2, 10_000);
        const cache = makeCache({ plugins: [rl] });
        await cache.set("k", 1);
        await cache.set("k", 2);
        await expect(cache.set("k", 3)).rejects.toMatchObject({ code: "RATE_LIMITED" });
        rl.reset("k");
        await expect(cache.set("k", 3)).resolves.toBeUndefined();
    });
});

describe("PersistencePlugin / MetricsPlugin / WarmupPlugin", () => {
    it("mirrors writes, deletes, evictions and clear into localStorage", async () => {
        const cache = makeCache({ plugins: [new PersistencePlugin("bk")], maxSize: 150 });
        await cache.set("a", "x".repeat(100));
        expect(JSON.parse(localStorage.getItem("bk") ?? "{}")).toHaveProperty("a");
        await sleep(2);
        await cache.set("b", "y".repeat(100)); // evicts a
        expect(Object.keys(JSON.parse(localStorage.getItem("bk") ?? "{}"))).toEqual(["b"]);
        await cache.clear();
        expect(localStorage.getItem("bk")).toBeNull();
    });

    it("counts metrics", async () => {
        const metrics = new MetricsPlugin();
        const cache = makeCache({ plugins: [metrics] });
        await cache.set("k", 1);
        await cache.get("k");
        await cache.get("nope");
        await cache.remove("k");
        expect(metrics.getAllMetrics()).toMatchObject({ sets: 1, hits: 1, misses: 1, deletes: 1 });
    });

    it("warms up", async () => {
        const warm = new WarmupPlugin();
        warm.addWarmupData("cfg", { a: 1 });
        const cache = makeCache();
        await warm.warmup(cache);
        expect(await cache.get("cfg")).toEqual({ a: 1 });
    });
});

describe("CacheAdminPanel / CacheMonitor", () => {
    it("builds panel data, report, honest health, and disposes listeners", async () => {
        const cache = makeCache();
        const panel = new CacheAdminPanel(cache);

        // Fresh cache with no traffic → healthy (used to warn about hit rate).
        expect((await panel.getData()).health).toMatchObject({ status: "healthy", warnings: [] });

        await cache.set("a", 1, { tags: ["t"] });
        for (let i = 0; i < 3; i++) await cache.get("a");
        const data = await panel.getData();
        expect(data.topKeys[0]).toMatchObject({ key: "a", accessCount: 3 });
        expect(data.entries).toHaveLength(1);
        expect(data.recentActivity.length).toBeGreaterThan(0);
        expect(typeof (await panel.generateReport())).toBe("string");

        // Many misses → low hit rate warning.
        for (let i = 0; i < 20; i++) await cache.get(`miss${i}`);
        expect((await panel.getData()).health.status).toBe("warning");

        panel.dispose();
        const before = panel.getRecentActivity().length;
        await cache.set("b", 2);
        expect(panel.getRecentActivity().length).toBe(before);
    });

    it("monitor measures successes and failures", async () => {
        const monitor = new CacheMonitor(makeCache());
        await monitor.measure("ok", async () => 1);
        await expect(
            monitor.measure("bad", async () => {
                throw new Error("x");
            })
        ).rejects.toThrow("x");
        expect(monitor.getMetrics()).toHaveLength(2);
        expect(monitor.getSuccessRate()).toBeCloseTo(0.5);
        expect(monitor.getSuccessRate("bad")).toBe(0);
        expect(monitor.getAverageDuration()).toBeGreaterThanOrEqual(0);
    });
});

describe("backward compatibility", () => {
    it("PrefetchPlugin: legacy loaders (returning void / unrelated data) still work and never write junk", async () => {
        const prefetch = new PrefetchPlugin();
        const calls: string[] = [];
        // 0.4 style: loader populates the cache itself and returns nothing.
        let cacheRef: ReturnType<typeof makeCache> | undefined;
        prefetch.addPrefetchRule("a", ["b"], async () => {
            calls.push("legacy");
            await cacheRef?.set("b", "from-loader");
        });
        // Loader that returns an unrelated payload (previously discarded).
        prefetch.addPrefetchRule("x", ["y"], async () => ({ unrelated: 1, other: 2 }));
        const cache = makeCache({ plugins: [prefetch] });
        cacheRef = cache;
        await cache.set("a", 1);
        await cache.set("x", 1);
        await cache.get("a");
        await cache.get("x");
        await sleep(60);
        expect(calls).toEqual(["legacy"]);
        expect(await cache.get("b")).toBe("from-loader");
        expect((await cache.keys()).sort()).toEqual(["a", "b", "x"]); // no "unrelated"/"other"
    });

    it("debounce/throttle accept typed callbacks and an explicit type argument", async () => {
        const { debounce, throttle } = await import("../src");
        const seen: number[] = [];
        const fn = (n: number): void => void seen.push(n);
        const d = debounce<typeof fn>(fn, 5);
        const t = throttle(fn, 5);
        d(1);
        d(2);
        t(3);
        t(4);
        await sleep(30);
        expect(seen.sort()).toEqual([2, 3]);
    });
});
