import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";
import { cachedFetch, createFetchHandler, freshnessFromHeaders } from "../src/integrations/fetch";
import { instrumentOpenTelemetry, type MeterLike } from "../src/integrations/opentelemetry";
import { cacheStatsStore, cacheStore, cacheValueStore } from "../src/integrations/svelte";
import {
    createCacheCraftPersister,
    createCacheCraftStorage,
} from "../src/integrations/tanstack-query";
import {
    useCache as useVueCache,
    useCacheValue as useVueCacheValue,
} from "../src/integrations/vue";
import { destroyAll, makeCache, sleep } from "./helpers";

afterEach(destroyAll);

function mockFetch(handler: (req: Request) => Response | Promise<Response>) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        handler(new Request(input, init))
    );
}

describe("cachedFetch", () => {
    it("honours max-age, and dedupes concurrent requests", async () => {
        const cache = makeCache();
        const fetch = mockFetch(async () => {
            await sleep(10);
            return new Response(JSON.stringify({ ok: 1 }), {
                headers: { "cache-control": "max-age=60", "content-type": "application/json" },
            });
        });
        const [a, b] = await Promise.all([
            cachedFetch(cache, "https://api.test/x", undefined, { fetch }),
            cachedFetch(cache, "https://api.test/x", undefined, { fetch }),
        ]);
        expect(await a.json()).toEqual({ ok: 1 });
        expect(await b.json()).toEqual({ ok: 1 });
        const c = await cachedFetch(cache, "https://api.test/x", undefined, { fetch });
        expect(c.headers.get("x-cachecraft-cache")).toBe("HIT");
        expect(c.headers.get("content-type")).toBe("application/json");
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("revalidates with ETag and refreshes on 304", async () => {
        const cache = makeCache();
        let calls = 0;
        const fetch = mockFetch((req) => {
            calls++;
            if (req.headers.get("if-none-match") === '"v1"') {
                return new Response(null, {
                    status: 304,
                    headers: { "cache-control": "max-age=60" },
                });
            }
            return new Response("body", { headers: { etag: '"v1"', "cache-control": "no-cache" } });
        });
        const first = await cachedFetch(cache, "https://api.test/e", undefined, { fetch });
        expect(first.headers.get("x-cachecraft-cache")).toBe("MISS");
        const second = await cachedFetch(cache, "https://api.test/e", undefined, { fetch });
        expect(second.headers.get("x-cachecraft-cache")).toBe("REVALIDATED");
        expect(await second.text()).toBe("body");
        const third = await cachedFetch(cache, "https://api.test/e", undefined, { fetch });
        expect(third.headers.get("x-cachecraft-cache")).toBe("HIT");
        expect(calls).toBe(2);
    });

    it("does not store no-store responses or non-GET requests", async () => {
        const cache = makeCache();
        const fetch = mockFetch(
            () => new Response("x", { headers: { "cache-control": "no-store" } })
        );
        await cachedFetch(cache, "https://api.test/n", undefined, { fetch });
        await cachedFetch(cache, "https://api.test/n", { method: "POST", body: "1" }, { fetch });
        expect(await cache.count()).toBe(0);
    });

    it("serves stale on network errors and supports SWR / network-first / cache-only", async () => {
        const cache = makeCache();
        let up = true;
        const fetch = mockFetch(() => {
            if (!up) throw new TypeError("offline");
            return new Response("v", {
                headers: {
                    "cache-control": "max-age=0",
                    "last-modified": new Date(0).toUTCString(),
                },
            });
        });
        await cachedFetch(cache, "https://api.test/s", undefined, { fetch, ttl: 10 });
        await sleep(20);
        up = false;
        const stale = await cachedFetch(cache, "https://api.test/s", undefined, { fetch });
        expect(stale.headers.get("x-cachecraft-cache")).toBe("STALE");
        const swr = await cachedFetch(cache, "https://api.test/s", undefined, {
            fetch,
            strategy: "stale-while-revalidate",
        });
        expect(await swr.text()).toBe("v");
        const nf = await cachedFetch(cache, "https://api.test/s", undefined, {
            fetch,
            strategy: "network-first",
        });
        expect(nf.headers.get("x-cachecraft-cache")).toBe("STALE");
        const only = await cachedFetch(cache, "https://api.test/none", undefined, {
            fetch,
            strategy: "cache-only",
        });
        expect(only.status).toBe(504);
        await expect(
            cachedFetch(cache, "https://api.test/none", undefined, { fetch })
        ).rejects.toThrow("offline");
    });

    it("computes freshness from headers", () => {
        const base = { url: "", status: 200, statusText: "", body: null, storedAt: 0 };
        expect(freshnessFromHeaders({ ...base, headers: [["cache-control", "max-age=5"]] })).toBe(
            5000
        );
        expect(
            freshnessFromHeaders({ ...base, headers: [["cache-control", "no-store"]] })
        ).toBeUndefined();
        expect(
            freshnessFromHeaders({
                ...base,
                headers: [
                    ["cache-control", "no-cache"],
                    ["etag", "x"],
                ],
            })
        ).toBe(0);
        expect(freshnessFromHeaders({ ...base, headers: [] })).toBeUndefined();
        const now = Date.now();
        expect(
            freshnessFromHeaders(
                {
                    ...base,
                    headers: [
                        ["expires", new Date(now + 60_000).toUTCString()],
                        ["date", new Date(now).toUTCString()],
                    ],
                },
                now
            )
        ).toBeGreaterThan(55_000);
    });

    it("createFetchHandler works as a Service Worker / Workbox handler", async () => {
        const cache = makeCache();
        const fetch = mockFetch(
            () => new Response("sw", { headers: { "cache-control": "max-age=60" } })
        );
        const handler = createFetchHandler(cache, { fetch, varyHeaders: ["accept-language"] });
        const res = await handler({
            request: new Request("https://app.test/a", { headers: { "accept-language": "fa" } }),
        });
        expect(await res.text()).toBe("sw");
        expect((await cache.keys())[0]).toContain("accept-language=fa");
    });
});

describe("TanStack Query", () => {
    it("persists, restores and removes the dehydrated client", async () => {
        const cache = makeCache();
        const persister = createCacheCraftPersister(cache, { throttleTime: 10 });
        const client = {
            timestamp: 1,
            buster: "",
            clientState: { queries: [{ queryKey: ["a"], state: { data: new Date(0) } }] },
        };
        persister.persistClient(client);
        persister.persistClient({ ...client, timestamp: 2 }); // coalesced
        await persister.flush();
        const restored = await persister.restoreClient();
        expect(restored?.timestamp).toBe(2);
        const state = restored?.clientState as { queries: Array<{ state: { data: Date } }> };
        expect(state.queries[0]?.state.data).toBeInstanceOf(Date);
        await persister.removeClient();
        expect(await persister.restoreClient()).toBeUndefined();
    });

    it("provides an AsyncStorage for per-query persisters", async () => {
        const cache = makeCache();
        const storage = createCacheCraftStorage<string>(cache);
        await storage.setItem("q1", "v1");
        expect(await storage.getItem("q1")).toBe("v1");
        expect(await storage.entries()).toEqual([["q1", "v1"]]);
        await storage.removeItem("q1");
        expect(await storage.getItem("q1")).toBeUndefined();
    });
});

describe("OpenTelemetry", () => {
    it("records counters, durations and gauges", async () => {
        const counts: Record<string, number> = {};
        const histograms: Array<[string, number, Record<string, unknown>]> = [];
        const gauges: Array<() => void> = [];
        const meter: MeterLike = {
            createCounter: (name) => ({
                add: (v) => {
                    counts[name] = (counts[name] ?? 0) + v;
                },
            }),
            createHistogram: (name) => ({
                record: (v, a) => void histograms.push([name, v, a ?? {}]),
            }),
            createObservableGauge: (name) => ({
                addCallback: (cb) =>
                    void gauges.push(() =>
                        cb({
                            observe: (v) => {
                                counts[name] = v;
                            },
                        })
                    ),
            }),
        };
        const cache = makeCache();
        const stop = instrumentOpenTelemetry(cache, { meter });
        await cache.set("k", 1);
        await cache.get("k");
        await cache.get("nope");
        for (const g of gauges) g();
        expect(counts).toMatchObject({
            "cachecraft.sets": 1,
            "cachecraft.hits": 1,
            "cachecraft.misses": 1,
            "cachecraft.entries": 1,
        });
        expect(
            histograms.some(
                ([n, , a]) =>
                    n === "cachecraft.operation.duration" && a["cache.operation"] === "get"
            )
        ).toBe(true);
        stop();
        await cache.set("k2", 1);
        expect(counts["cachecraft.sets"]).toBe(1);
    });
});

describe("Svelte stores", () => {
    it("loads on subscribe, follows writes and supports mutate/invalidate", async () => {
        const cache = makeCache();
        let calls = 0;
        const store = cacheStore(cache, "user", async () => {
            calls++;
            return { name: `v${calls}` };
        });
        const states: Array<{ data?: { name: string }; isLoading: boolean }> = [];
        const stop = store.subscribe((s) => void states.push(s));
        await sleep(20);
        expect(states[states.length - 1]).toMatchObject({ data: { name: "v1" }, isLoading: false });
        await cache.set("user", { name: "external" });
        expect(states[states.length - 1]?.data).toEqual({ name: "external" });
        await store.mutate((u) => ({ name: `${u?.name}!` }));
        expect(await cache.get("user")).toEqual({ name: "external!" });
        await store.invalidate();
        await sleep(20);
        expect(states[states.length - 1]?.data).toEqual({ name: "v2" });
        stop();

        const value = cacheValueStore<{ name: string }>(cache, "user");
        const seen: unknown[] = [];
        const stopValue = value.subscribe((v) => void seen.push(v));
        await sleep(10);
        expect(seen[seen.length - 1]).toEqual({ name: "v2" });
        stopValue();

        const stats = cacheStatsStore(cache, 1);
        let last: unknown = null;
        const stopStats = stats.subscribe((s) => {
            last = s;
        });
        await cache.get("user");
        await sleep(10);
        expect((last as { hits: number }).hits).toBeGreaterThan(0);
        stopStats();
    });
});

describe("Vue composables", () => {
    it("useCache reacts to the key and to writes", async () => {
        const cache = makeCache();
        const scope = effectScope();
        const { ref } = await import("vue");
        const id = ref(1);
        const state = scope.run(() =>
            useVueCache(
                () => `item:${id.value}`,
                async () => ({ id: id.value }),
                { engine: cache }
            )
        );
        await sleep(20);
        expect(state?.data.value).toEqual({ id: 1 });
        id.value = 2;
        await nextTick();
        await sleep(20);
        expect(state?.data.value).toEqual({ id: 2 });
        await cache.set("item:2", { id: 22 });
        expect(state?.data.value).toEqual({ id: 22 });
        await state?.mutate({ id: 23 });
        expect(await cache.get("item:2")).toEqual({ id: 23 });

        const value = scope.run(() =>
            useVueCacheValue<{ id: number }>("item:2", { engine: cache })
        );
        await sleep(10);
        expect(value?.value).toEqual({ id: 23 });
        scope.stop();
    });
});
