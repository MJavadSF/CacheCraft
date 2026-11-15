import { describe, expect, it } from "vitest";
import type { StorageAdapter, StoredMeta } from "../../src";

// A reusable contract every StorageAdapter must satisfy. Run in Node (fake
// IndexedDB, memory, Web Storage) and in a real browser (IndexedDB, OPFS).

function meta(extra: Partial<StoredMeta> = {}): StoredMeta {
    return {
        size: 3,
        createdAt: 1,
        lastAccessed: 1,
        accessCount: 0,
        isCompressed: false,
        isEncrypted: false,
        isEncoded: false,
        serializer: "rich",
        kind: "value",
        ...extra,
    };
}

export function adapterContract(
    name: string,
    create: () => StorageAdapter | Promise<StorageAdapter>
): void {
    describe(`StorageAdapter contract: ${name}`, () => {
        it("puts, gets and loads metadata per namespace", async () => {
            const a = await create();
            await a.write("", [
                { type: "put", key: "k", meta: meta({ tags: ["t"] }), payload: "abc" },
            ]);
            await a.write("ns", [
                { type: "put", key: "k", meta: meta(), payload: new Uint8Array([1, 2]) },
            ]);
            const root = await a.get("", ["k", "missing"]);
            expect(root.get("k")?.payload).toBe("abc");
            expect(root.get("k")?.meta.tags).toEqual(["t"]);
            expect(root.has("missing")).toBe(false);
            const ns = await a.get("ns", ["k"]);
            expect(Array.from(ns.get("k")?.payload as Uint8Array)).toEqual([1, 2]);
            expect((await a.loadMeta("")).map(([k]) => k)).toEqual(["k"]);
            expect((await a.getMeta("ns", ["k"])).get("k")?.size).toBe(3);
            a.close();
        });

        it("never lets a namespace see a prefix-sharing sibling", async () => {
            const a = await create();
            await a.write("a:b", [{ type: "put", key: "k", meta: meta(), payload: "1" }]);
            await a.write("a", [{ type: "put", key: "b:k", meta: meta(), payload: "2" }]);
            expect((await a.loadMeta("a")).map(([k]) => k)).toEqual(["b:k"]);
            expect((await a.loadMeta("a:b")).map(([k]) => k)).toEqual(["k"]);
            await a.clear("a");
            expect((await a.get("a:b", ["k"])).get("k")?.payload).toBe("1");
            a.close();
        });

        it("deletes, reports what existed, and conditionally deletes expired records", async () => {
            const a = await create();
            await a.write("", [
                { type: "put", key: "x", meta: meta(), payload: "1" },
                { type: "put", key: "old", meta: meta({ expiresAt: 10 }), payload: "1" },
                { type: "put", key: "new", meta: meta({ expiresAt: 10_000 }), payload: "1" },
            ]);
            const r1 = await a.write("", [
                { type: "delete", key: "x" },
                { type: "delete", key: "never" },
            ]);
            expect(r1.deleted).toEqual(["x"]);
            const r2 = await a.write("", [
                { type: "deleteIfExpired", key: "old", now: 100 },
                { type: "deleteIfExpired", key: "new", now: 100 },
            ]);
            expect(r2.deleted).toEqual(["old"]);
            expect((await a.loadMeta("")).map(([k]) => k)).toEqual(["new"]);
            a.close();
        });

        it("touch merges access metadata and expiry", async () => {
            const a = await create();
            await a.write("", [
                { type: "put", key: "k", meta: meta({ expiresAt: 50 }), payload: "1" },
            ]);
            await a.write("", [{ type: "touch", key: "k", lastAccessed: 9, accessDelta: 2 }]);
            await a.write("", [
                { type: "touch", key: "k", lastAccessed: 5, accessDelta: 1, expiresAt: null },
            ]);
            await a.write("", [{ type: "touch", key: "missing", accessDelta: 1 }]);
            const m = (await a.getMeta("", ["k"])).get("k");
            expect(m).toMatchObject({ lastAccessed: 9, accessCount: 3 });
            expect(m?.expiresAt).toBeUndefined();
            expect((await a.getMeta("", ["missing"])).size).toBe(0);
            a.close();
        });

        it("keeps system values (get-or-create)", async () => {
            const a = await create();
            const first = await a.initSystem("salt", () => "s1");
            const second = await a.initSystem("salt", () => "s2");
            expect(first).toBe("s1");
            expect(second).toBe("s1");
            expect(await a.getSystem("salt")).toBe("s1");
            a.close();
        });
    });
}
