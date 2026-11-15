import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";
import {
    type CacheEntryMeta,
    createCache,
    createClientCache,
    createEvictionPolicy,
    createTypedCache,
    debounce,
    deepClone,
    FIFOEvictionPolicy,
    formatDuration,
    formatPercentage,
    generateId,
    isClient,
    isSafari,
    isSSR,
    LFUEvictionPolicy,
    LRUEvictionPolicy,
    PerformanceTimer,
    PriorityEvictionPolicy,
    SegmentedEvictionPolicy,
    SizeBasedEvictionPolicy,
    TTLEvictionPolicy,
    throttle,
} from "../src";
import { MemoryTier } from "../src/core/memory-tier";
import { mountDevtools } from "../src/devtools";
import { rankFor } from "../src/eviction";
import { cacheStore } from "../src/integrations/svelte";
import { useCache as useVueCache, useCacheStats as useVueStats } from "../src/integrations/vue";
import { acquireLeadership, KeyedMutex, withWebLock } from "../src/locks";
import { decodeLegacyBase64, encodeLegacyBase64 } from "../src/utils";
import { destroyAll, makeCache, sleep } from "./helpers";

afterEach(async () => {
    vi.unstubAllGlobals();
    for (const n of document.querySelectorAll("[data-cachecraft-devtools]")) n.remove();
    await destroyAll();
});

function meta(key: string, extra: Partial<CacheEntryMeta> = {}): CacheEntryMeta {
    return {
        key,
        size: 10,
        createdAt: 0,
        lastAccessed: 0,
        accessCount: 0,
        isCompressed: false,
        isEncrypted: false,
        isEncoded: false,
        ...extra,
    };
}

describe("eviction policies", () => {
    const entries = [
        meta("old-hot", {
            createdAt: 1,
            lastAccessed: 50,
            accessCount: 9,
            priority: 5,
            size: 30,
            expiresAt: 900,
        }),
        meta("new-cold", { createdAt: 9, lastAccessed: 10, accessCount: 1, priority: 1, size: 10 }),
        meta("mid", {
            createdAt: 5,
            lastAccessed: 30,
            accessCount: 3,
            priority: 1,
            size: 20,
            expiresAt: 100,
        }),
    ];
    const order = (policy: { rank(e: CacheEntryMeta[]): CacheEntryMeta[] }) =>
        policy.rank(entries).map((e) => e.key);

    it("rank entries by their own criterion", () => {
        expect(order(new LRUEvictionPolicy())).toEqual(["new-cold", "mid", "old-hot"]);
        expect(order(new LFUEvictionPolicy())).toEqual(["new-cold", "mid", "old-hot"]);
        expect(order(new FIFOEvictionPolicy())).toEqual(["old-hot", "mid", "new-cold"]);
        expect(order(new PriorityEvictionPolicy())).toEqual(["new-cold", "mid", "old-hot"]);
        expect(order(new SegmentedEvictionPolicy())).toEqual(["new-cold", "mid", "old-hot"]);
        expect(order(new TTLEvictionPolicy())).toEqual(["mid", "old-hot", "new-cold"]);
        expect(order(new SizeBasedEvictionPolicy())).toEqual(["old-hot", "mid", "new-cold"]);
    });

    it("shouldEvict frees just enough bytes", () => {
        expect(new LRUEvictionPolicy().shouldEvict(entries, 60, 60)).toEqual([]);
        expect(new LRUEvictionPolicy().shouldEvict(entries, 45, 60)).toEqual(["new-cold", "mid"]);
        expect(new SizeBasedEvictionPolicy().shouldEvict(entries, 40, 60)).toEqual(["old-hot"]);
    });

    it("factory and fallback ranking", () => {
        for (const name of [
            "lru",
            "lfu",
            "fifo",
            "priority",
            "segmented",
            "arc",
            "ttl",
            "size",
            "???",
        ]) {
            expect(createEvictionPolicy(name).name).toBeTruthy();
        }
        const custom = { name: "c", shouldEvict: () => [] };
        expect(rankFor(custom, entries).map((e) => e.key)).toEqual(["new-cold", "mid", "old-hot"]);
    });

    it("engine works with every strategy", async () => {
        for (const evictionStrategy of [
            "lfu",
            "fifo",
            "priority",
            "segmented",
            "ttl",
            "size",
        ] as const) {
            const cache = makeCache({ evictionStrategy, maxSize: 250 });
            for (let i = 0; i < 6; i++)
                await cache.set(`k${i}`, "x".repeat(60), { priority: i, ttl: 10_000 + i });
            expect(await cache.size()).toBeLessThanOrEqual(250);
        }
    });
});

describe("memory tier", () => {
    it("is an LRU bounded by entries and bytes", () => {
        const tier = new MemoryTier(2, 100, false);
        tier.set("a", 1, 10, undefined);
        tier.set("b", 2, 10, undefined);
        tier.get("a", 0); // a is now most recent
        tier.set("c", 3, 10, undefined);
        expect(tier.get("b", 0)).toBeUndefined();
        expect(tier.get("a", 0)?.value).toBe(1);
        tier.set("huge", 4, 1000, undefined);
        expect(tier.get("huge", 0)).toBeUndefined();
        tier.set("big", 5, 95, undefined);
        expect(tier.size).toBe(1);
        tier.setExpiry("big", 5);
        expect(tier.get("big", 10)).toBeUndefined();
        tier.clear();
        expect(tier.size).toBe(0);
    });
});

describe("locks", () => {
    it("KeyedMutex serialises per key and runs keys independently", async () => {
        const mutex = new KeyedMutex();
        const log: string[] = [];
        await Promise.all([
            mutex.run("a", async () => {
                log.push("a1+");
                await sleep(10);
                log.push("a1-");
            }),
            mutex.run("a", async () => {
                log.push("a2");
            }),
            mutex.run("b", async () => {
                log.push("b");
            }),
        ]);
        expect(log.indexOf("a2")).toBeGreaterThan(log.indexOf("a1-"));
        expect(log.indexOf("b")).toBeLessThan(log.indexOf("a1-"));
    });

    it("withWebLock / acquireLeadership degrade gracefully and use navigator.locks when present", async () => {
        expect(await withWebLock("x", async () => 1)).toBe(1);
        let leader = false;
        acquireLeadership("y", () => {
            leader = true;
        })();
        expect(leader).toBe(true);

        const requests: string[] = [];
        vi.stubGlobal("navigator", {
            ...navigator,
            locks: {
                request: async (name: string, _opts: unknown, cb: () => unknown) => {
                    requests.push(name);
                    return cb();
                },
            },
        });
        expect(await withWebLock("z", async () => 2)).toBe(2);
        const release = acquireLeadership("lead", () => requests.push("leader"));
        await sleep(0);
        release();
        expect(requests).toEqual(["z", "lead", "leader"]);
    });
});

describe("misc utilities", () => {
    it("legacy base64, formatting, ids, timers, env checks", async () => {
        expect(decodeLegacyBase64(encodeLegacyBase64("سلام 👋"))).toBe("سلام 👋");
        expect(formatDuration(500)).toBe("500ms");
        expect(formatDuration(90_000)).toBe("1.5m");
        expect(formatDuration(7_200_000)).toBe("2.0h");
        expect(formatDuration(172_800_000)).toBe("2.0d");
        expect(formatPercentage(0.5)).toBe("50.00%");
        expect(generateId()).not.toBe(generateId());
        expect(deepClone({ a: [1] })).toEqual({ a: [1] });
        expect(typeof isSafari()).toBe("boolean");
        expect(isClient()).toBe(true);
        expect(isSSR()).toBe(false);
        const timer = new PerformanceTimer();
        expect(timer.elapsed()).toBeGreaterThanOrEqual(0);
        timer.reset();

        const calls: number[] = [];
        const d = debounce((n: number) => calls.push(n), 5);
        d(1);
        d(2);
        const t = throttle((n: number) => calls.push(n * 10), 50);
        t(1);
        t(2);
        await sleep(15);
        expect(calls).toEqual([10, 2]);
    });

    it("createCache / createClientCache", async () => {
        const a = createCache({ dbName: "factory-a", autoCleanup: false });
        const b = createClientCache({ dbName: "factory-b", autoCleanup: false });
        expect(b).not.toBeNull();
        await a.destroy();
        await b?.destroy();
    });
});

describe("typed facade", () => {
    it("forwards every method", async () => {
        const typed = createTypedCache<{ a: number; b: string }>({
            dbName: `typed-${Date.now()}`,
            autoCleanup: false,
        });
        await typed.set("a", 1);
        expect(await typed.getOrSet("b", () => "x")).toBe("x");
        expect(await typed.peek("a")).toBe(1);
        expect((await typed.getWithMeta("a"))?.value).toBe(1);
        expect(await typed.update("a", (n) => (n ?? 0) + 1)).toBe(2);
        expect(await typed.has("a")).toBe(true);
        expect(await typed.touch("a", "1m")).toBe(true);
        expect(await typed.remove("a")).toBe(true);
        expect(await typed.get("a")).toBeNull();
        await typed.engine.destroy();
    });
});

describe("Vue extras", () => {
    it("invalidate, refresh, refreshInterval and stats", async () => {
        const cache = makeCache();
        let calls = 0;
        const scope = effectScope();
        const state = scope.run(() =>
            useVueCache("k", () => ++calls, {
                engine: cache,
                refreshInterval: 15,
                revalidateOnFocus: true,
                revalidateOnReconnect: true,
            })
        );
        const stats = scope.run(() => useVueStats({ engine: cache, throttleMs: 1 }));
        await sleep(50);
        expect(calls).toBeGreaterThanOrEqual(3);
        await state?.invalidate();
        await state?.refresh();
        window.dispatchEvent(new Event("online"));
        await sleep(10);
        expect(state?.data.value).toBeGreaterThan(1);
        expect(stats?.value?.sets).toBeGreaterThan(0);
        scope.stop();
    });

    it("stays idle without an engine", () => {
        const scope = effectScope();
        const state = scope.run(() => useVueCache("k", () => 1, { engine: null }));
        expect(state?.isLoading.value).toBe(false);
        scope.stop();
    });
});

describe("Svelte extras", () => {
    it("is inert without an engine", () => {
        const store = cacheStore(null, "k", () => 1);
        const seen: unknown[] = [];
        store.subscribe((s) => void seen.push(s))();
        expect(seen).toHaveLength(1);
    });
});

describe("devtools extras", () => {
    it("switches engines, pages, shows storage info and exports", async () => {
        const a = makeCache({ label: "A" });
        const b = makeCache({ label: "B" });
        for (let i = 0; i < 5; i++) await a.set(`k${i}`, i, { tags: ["t"] });
        const createURL = vi.fn(() => "blob:x");
        vi.stubGlobal(
            "URL",
            Object.assign(URL, { createObjectURL: createURL, revokeObjectURL: () => undefined })
        );
        const devtools = mountDevtools({
            engines: [a, b],
            initialIsOpen: true,
            pageSize: 2,
            position: "top-left",
            theme: "dark",
        });
        const root = () =>
            document.querySelector("[data-cachecraft-devtools]")?.shadowRoot as ShadowRoot;
        const click = (label: string) =>
            (
                [...root().querySelectorAll("button")].find((x) =>
                    x.textContent?.startsWith(label)
                ) as HTMLButtonElement
            ).click();
        await sleep(40);
        click("Entries");
        await sleep(40);
        expect(root().textContent).toContain("1 / 3");
        click("›");
        await sleep(40);
        expect(root().textContent).toContain("2 / 3");
        click("Tags");
        await sleep(40);
        click("Show");
        await sleep(40);
        expect(root().textContent).toContain("5 entries");
        click("Storage");
        await sleep(40);
        expect(root().textContent).toContain("Backend");
        click("Overview");
        await sleep(40);
        click("Export JSON");
        await sleep(40);
        expect(createURL).toHaveBeenCalled();
        click("Clean up expired");
        click("Reset stats");
        await sleep(40);
        devtools.select(b.id);
        await sleep(40);
        expect(root().textContent).toContain("B");
        devtools.close();
        await sleep(10);
        expect(root().querySelector(".cc-panel")).toBeNull();
        devtools.toggle();
        await sleep(40);
        expect(root().querySelector(".cc-panel")).not.toBeNull();
        devtools.destroy();
    });
});

describe("built-in plugins (smoke)", () => {
    it("logger, debug, analytics, metrics, tag manager and validation hooks fire", async () => {
        const {
            LoggerPlugin,
            DebugPlugin,
            AnalyticsPlugin,
            MetricsPlugin,
            TagManagerPlugin,
            ValidationPlugin,
            CompressionOptimizerPlugin,
            TTLRefreshPlugin,
        } = await import("../src");
        const logs: string[] = [];
        const events: string[] = [];
        const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const metrics = new MetricsPlugin();
        const tags = new TagManagerPlugin();
        const validation = new ValidationPlugin();
        validation.addValidator(/^n:/, (v) => typeof v === "number");
        const cache = makeCache({
            maxSize: 200,
            plugins: [
                new LoggerPlugin((m) => logs.push(m)),
                new DebugPlugin(true),
                new AnalyticsPlugin((e) => events.push(e)),
                metrics,
                tags,
                validation,
                new CompressionOptimizerPlugin(10_000),
                new TTLRefreshPlugin(60_000),
            ],
        });
        await cache.set("a", "x".repeat(50), { tags: ["t"], ttl: 1000 });
        await cache.get("a");
        await cache.get("missing");
        await cache.set("b", "y".repeat(180)); // evicts a
        await cache.remove("b");
        await expect(cache.set("n:1", "nope")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
        expect(logs.some((l) => l.includes("Hit: a"))).toBe(true);
        expect(logs.some((l) => l.includes("Evicted"))).toBe(true);
        expect(events).toEqual(expect.arrayContaining(["cache_set", "cache_get", "cache_evict"]));
        expect(metrics.getMetric("hits")).toBe(1);
        expect(metrics.getMetric("key:a:hits")).toBe(1);
        metrics.reset();
        expect(metrics.getAllMetrics()).toEqual({});
        expect(tags.getAllTags()).toEqual([]);
        expect(tags.getTagsForKey("a")).toEqual([]);
        expect(debug).toHaveBeenCalled();
        expect(error).toHaveBeenCalled();
        await cache.clear();
        debug.mockRestore();
        error.mockRestore();
    });
});
