import { describe, expect, it } from "vitest";
import { IndexedDBAdapter, MemoryAdapter, QuotaExceededError, WebStorageAdapter } from "../src";
import { makeCache, uniqueDb } from "./helpers";
import { adapterContract } from "./shared/adapter-contract";

adapterContract("indexeddb (fake-indexeddb)", () => new IndexedDBAdapter(uniqueDb(), "cache"));
adapterContract("memory", () => new MemoryAdapter(uniqueDb(), "cache"));
adapterContract("localStorage", () => WebStorageAdapter.from("localStorage", uniqueDb(), "cache"));

describe("WebStorageAdapter", () => {
    it("rolls a batch back when the quota is hit half-way", async () => {
        const store = new Map<string, string>();
        let writes = 0;
        const fake = {
            get length() {
                return store.size;
            },
            key: (i: number) => [...store.keys()][i] ?? null,
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => {
                if (++writes > 3) {
                    const e = new Error("full");
                    e.name = "QuotaExceededError";
                    throw e;
                }
                store.set(k, v);
            },
            removeItem: (k: string) => void store.delete(k),
        };
        const adapter = new WebStorageAdapter(fake, "db", "s");
        const meta = {
            size: 1,
            createdAt: 1,
            lastAccessed: 1,
            accessCount: 0,
            isCompressed: false,
            isEncrypted: false,
            isEncoded: false,
        };
        await expect(
            adapter.write("", [
                { type: "put", key: "a", meta, payload: "1" },
                { type: "put", key: "b", meta, payload: "2" },
            ])
        ).rejects.toBeInstanceOf(QuotaExceededError);
        expect(store.size).toBe(0);
    });
});

describe("engine on alternative backends", () => {
    for (const storage of ["memory", "localStorage", "sessionStorage"] as const) {
        it(`works end-to-end on ${storage}`, async () => {
            const cache = makeCache({ storage, compression: { threshold: 10 } });
            await cache.set("k", { big: "x".repeat(500) }, { tags: ["t"] });
            await cache.setBlob("b", new Blob([new Uint8Array([1, 2, 3])]));
            expect(await cache.get("k")).toEqual({ big: "x".repeat(500) });
            expect((await cache.getBlob("b"))?.size).toBe(3);
            expect(await cache.invalidateByTag("t")).toBe(1);
            expect(await cache.count()).toBe(1);
            await cache.clear();
        });
    }

    it("memory storage is shared by engines on the same db (like IndexedDB)", async () => {
        const dbName = uniqueDb();
        const a = makeCache({ dbName, storage: "memory" });
        const b = makeCache({ dbName, storage: "memory" });
        await a.set("k", 1);
        expect(await b.get("k")).toBe(1);
        MemoryAdapter.reset(dbName);
        expect(await makeCache({ dbName, storage: "memory" }).get("k")).toBeNull();
    });
});
