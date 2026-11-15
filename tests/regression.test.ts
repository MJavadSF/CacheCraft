import { afterEach, describe, expect, it } from "vitest";
import { CacheEngine, PersistencePlugin, PrefetchPlugin } from "../src";
import { destroyAll, makeCache, uniqueDb } from "./helpers";

// Regression tests for the defects found in the 0.5 → 1.0 review.

afterEach(async () => {
    localStorage.clear();
    await destroyAll();
});

describe("namespace isolation", () => {
    it("the root engine neither counts nor clears namespaced entries", async () => {
        const root = makeCache();
        const users = root.namespace("users");
        await users.set("a", 1);
        await root.set("x", 2);

        expect(await root.count()).toBe(1);
        expect(await root.keys()).toEqual(["x"]);
        await root.clear();
        expect(await users.get("a")).toBe(1);
        await users.destroy();
    });

    it("namespace prefixes never overlap ('a' vs 'a:b')", async () => {
        const dbName = uniqueDb();
        const ab = makeCache({ dbName, namespace: "a:b" });
        const a = makeCache({ dbName, namespace: "a" });
        await ab.set("k", 1);
        await a.set("b:k", "mine");

        expect(await a.keys()).toEqual(["b:k"]);
        expect(await ab.keys()).toEqual(["k"]);
        await a.clear();
        expect(await ab.get("k")).toBe(1);
    });

    it("eviction in one namespace never touches another", async () => {
        const dbName = uniqueDb();
        const big = makeCache({ dbName, namespace: "big", maxSize: 300 });
        const other = makeCache({ dbName, namespace: "other" });
        await other.set("keep", "x".repeat(200));
        for (let i = 0; i < 10; i++) await big.set(`k${i}`, "y".repeat(100));
        expect(await other.get("keep")).toBe("x".repeat(200));
        expect(await big.size()).toBeLessThanOrEqual(300);
    });
});

describe("visibility across engines", () => {
    it("reads through to storage when another engine wrote the key (sync off)", async () => {
        const dbName = uniqueDb();
        const e1 = makeCache({ dbName, enableSync: false });
        const e2 = makeCache({ dbName, enableSync: false });
        await e2.ready();
        await e1.set("k", 42);
        expect(await e2.get("k")).toBe(42);
        expect(await e2.has("k")).toBe(true);
        expect(await e2.count()).toBe(1); // index healed
    });

    it("does not delete an entry another engine refreshed after it expired here", async () => {
        const dbName = uniqueDb();
        const e1 = makeCache({ dbName, enableSync: false });
        const e2 = makeCache({ dbName, enableSync: false });
        await e1.set("k", "old", { ttl: 20 });
        await e2.get("k"); // e2 indexes the short TTL
        await new Promise((r) => setTimeout(r, 40));
        await e1.set("k", "new", { ttl: 60_000 });
        expect(await e2.get("k")).toBe("new");
        expect(await e1.get("k")).toBe("new");
    });

    it("sees deletes made by another engine", async () => {
        const dbName = uniqueDb();
        const e1 = makeCache({ dbName, enableSync: false });
        const e2 = makeCache({ dbName, enableSync: false });
        await e1.set("k", 1);
        expect(await e2.get("k")).toBe(1);
        await e1.remove("k");
        expect(await e2.get("k")).toBeNull();
        expect(await e2.count()).toBe(0);
    });
});

describe("object stores", () => {
    it("a new storeName in an existing database just works (no manual version bump)", async () => {
        const dbName = uniqueDb();
        const s1 = makeCache({ dbName, storeName: "s1" });
        await s1.set("k", 1);
        const s2 = makeCache({ dbName, storeName: "s2" });
        await s2.set("k", 2);
        const s3 = makeCache({ dbName, storeName: "s3" });
        await s3.set("k", 3);
        expect([await s1.get("k"), await s2.get("k"), await s3.get("k")]).toEqual([1, 2, 3]);
    });
});

describe("plugins", () => {
    it("namespace() doesn't re-initialise shared plugin instances (Prefetch host stays bound)", async () => {
        const hosts: string[] = [];
        const spy = {
            name: "spy",
            init: (h: { namespace: string }) => void hosts.push(h.namespace),
        };
        const root = makeCache({ plugins: [spy] });
        const child = root.namespace("child");
        expect(hosts).toEqual([""]);
        await child.destroy();
    });

    it("plugin factories get one fresh instance per engine", async () => {
        const created: PrefetchPlugin[] = [];
        const root = makeCache({
            plugins: [
                () => {
                    const p = new PrefetchPlugin();
                    created.push(p);
                    return p;
                },
            ],
        });
        const child = root.namespace("child");
        expect(created).toHaveLength(2);
        expect(created[0]).not.toBe(created[1]);
        await child.destroy();
    });

    it("PersistencePlugin never mirrors encrypted values in plaintext", async () => {
        const plugin = new PersistencePlugin("bk");
        const cache = makeCache({
            plugins: [plugin],
            encryptionKey: "s3cret",
            kdfIterations: 1000,
        });
        await cache.set("public", { a: 1 });
        await cache.set("secret", { card: "4111" }, { encrypt: true });
        plugin.flush();
        const raw = localStorage.getItem("bk") ?? "";
        expect(raw).toContain("public");
        expect(raw).not.toContain("4111");
        expect(plugin.loadFromLocalStorage()).toEqual({ public: { a: 1 } });
    });

    it("PersistencePlugin keeps namespaces apart", async () => {
        const plugin = () => new PersistencePlugin("bk");
        const root = makeCache({ plugins: [plugin] });
        const child = root.namespace("child");
        await root.set("k", "root");
        await child.set("k", "child");
        await new Promise((r) => setTimeout(r, 0));
        await root.clear();
        await new Promise((r) => setTimeout(r, 0));
        expect(localStorage.getItem("bk")).toBeNull();
        expect(localStorage.getItem("bk::child")).toContain("child");
        await child.destroy();
    });
});

describe("serialization", () => {
    it("round-trips Date, Map, Set, BigInt, RegExp, URL, typed arrays and special numbers", async () => {
        const cache = makeCache();
        const value = {
            d: new Date(0),
            m: new Map<unknown, unknown>([[1, { nested: new Date(5) }]]),
            s: new Set(["a"]),
            b: 10n,
            r: /x+/gi,
            u: new URL("https://example.com/a?b=1"),
            bytes: new Uint8Array([1, 2, 3]),
            f: new Float32Array([1.5]),
            n: [Number.NaN, Number.POSITIVE_INFINITY, -0],
            missing: undefined,
            tagLike: { $cc: "Date", v: 1 },
        };
        await cache.set("rich", value);
        const out = (await cache.get<typeof value>("rich")) as typeof value;
        expect(out.d).toBeInstanceOf(Date);
        expect(out.d.getTime()).toBe(0);
        expect(out.m.get(1)).toEqual({ nested: new Date(5) });
        expect(out.s.has("a")).toBe(true);
        expect(out.b).toBe(10n);
        expect(out.r.flags).toBe("gi");
        expect(out.u.href).toBe("https://example.com/a?b=1");
        expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
        expect(out.f).toBeInstanceOf(Float32Array);
        expect(Number.isNaN(out.n[0])).toBe(true);
        expect(out.n[1]).toBe(Number.POSITIVE_INFINITY);
        expect(Object.is(out.n[2], -0)).toBe(true);
        expect("missing" in out).toBe(true);
        expect(out.tagLike).toEqual({ $cc: "Date", v: 1 });
    });

    it("still reads plain-JSON entries and supports serializer: 'json'", async () => {
        const dbName = uniqueDb();
        const json = makeCache({ dbName, serializer: "json" });
        await json.set("k", { d: new Date(0) });
        expect(await json.get("k")).toEqual({ d: "1970-01-01T00:00:00.000Z" });
        const rich = makeCache({ dbName });
        expect(await rich.get("k")).toEqual({ d: "1970-01-01T00:00:00.000Z" });
    });
});

describe("encryption", () => {
    it("uses a random per-database salt (same passphrase → different ciphertexts across DBs)", async () => {
        const a = makeCache({ encryptionKey: "pw", kdfIterations: 1000 });
        const b = makeCache({ encryptionKey: "pw", kdfIterations: 1000 });
        await a.set("k", "v", { encrypt: true });
        await b.set("k", "v", { encrypt: true });
        const [ea] = await a.query({});
        const [eb] = await b.query({});
        expect(ea?.entry.keyId).toBeDefined();
        expect(ea?.entry.keyId).not.toBe(eb?.entry.keyId);
    });

    it("namespaces share the derived key (no re-derivation per namespace)", async () => {
        const root = makeCache({ encryptionKey: "pw", kdfIterations: 1000 });
        await root.set("k", 1, { encrypt: true });
        const child = root.namespace("c");
        await child.set("k", 2, { encrypt: true });
        const [r] = await root.query({});
        const [c] = await child.query({});
        expect(r?.entry.keyId).toBe(c?.entry.keyId);
        await child.destroy();
    });

    it("defaults to 600k PBKDF2 iterations", async () => {
        const { DEFAULT_KDF_ITERATIONS } = await import("../src");
        expect(DEFAULT_KDF_ITERATIONS).toBe(600_000);
    });
});

describe("error semantics", () => {
    it("remove() and clear() throw on storage failures instead of returning false/0", async () => {
        const cache = new CacheEngine({
            dbName: uniqueDb(),
            autoCleanup: false,
            storage: {
                kind: "broken",
                persistent: false,
                loadMeta: async () => [],
                getMeta: async () => new Map(),
                get: async () => new Map(),
                write: async () => {
                    throw new Error("disk on fire");
                },
                clear: async () => {
                    throw new Error("disk on fire");
                },
                getSystem: async () => undefined,
                initSystem: async (_k, create) => create(),
                close: () => undefined,
            },
        });
        await expect(cache.remove("k")).rejects.toThrow("disk on fire");
        await expect(cache.clear()).rejects.toThrow("disk on fire");
        await cache.destroy();
    });

    it("rejects non-string keys", async () => {
        const cache = makeCache();
        await expect(cache.set(1 as unknown as string, 1)).rejects.toMatchObject({
            code: "INVALID_KEY",
        });
    });
});
