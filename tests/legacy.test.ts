import { afterEach, describe, expect, it } from "vitest";
import { compress, EncryptionManager } from "../src";
import { destroyAll, makeCache, uniqueDb } from "./helpers";

// Data written by CacheCraft ≤0.5: one object store named after `storeName`,
// string keys "namespace:key", CacheEntry objects as values.

type LegacyEntry = Record<string, unknown>;

function legacyEntry(value: string | Uint8Array, extra: LegacyEntry = {}): LegacyEntry {
    const now = Date.now();
    return {
        value,
        isEncoded: false,
        isCompressed: false,
        isEncrypted: false,
        createdAt: now - 1000,
        lastAccessed: now - 500,
        accessCount: 3,
        size: typeof value === "string" ? value.length : value.byteLength,
        tags: [],
        ...extra,
    };
}

async function writeLegacyDb(dbName: string, entries: Record<string, LegacyEntry>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore("cache");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction("cache", "readwrite");
            for (const [key, entry] of Object.entries(entries))
                tx.objectStore("cache").put(entry, key);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        };
    });
}

afterEach(destroyAll);

describe("≤0.5 data", () => {
    it("is migrated lazily on first read, with its metadata", async () => {
        const dbName = uniqueDb();
        await writeLegacyDb(dbName, {
            plain: legacyEntry(JSON.stringify({ a: 1 }), { tags: ["t"], priority: 2 }),
            "users:1": legacyEntry(JSON.stringify("ada")),
            encoded: legacyEntry(btoa(encodeURIComponent(JSON.stringify([1, 2]))), {
                isEncoded: true,
            }),
            zipped: legacyEntry(await compress(JSON.stringify("z".repeat(1000))), {
                isCompressed: true,
            }),
        });
        const root = makeCache({ dbName });
        const users = makeCache({ dbName, namespace: "users" });

        expect(await root.get("plain")).toEqual({ a: 1 });
        expect(await root.keysByTag("t")).toEqual(["plain"]);
        expect(await users.get("1")).toBe("ada");
        expect(await root.get("encoded")).toEqual([1, 2]);
        expect(await root.get("zipped")).toBe("z".repeat(1000));
        // Moved, not copied: reading again comes from the new layout.
        expect(await root.has("plain")).toBe(true);
        const meta = (await root.queryMeta({ pattern: "plain" }))[0];
        expect(meta).toMatchObject({ priority: 2, serializer: "json" });
        expect(meta?.accessCount).toBeGreaterThanOrEqual(3);
    });

    it("keeps ≤0.5 encrypted entries readable with the same passphrase", async () => {
        const dbName = uniqueDb();
        const legacy = new EncryptionManager();
        await legacy.initialize("pw");
        const encrypted = await legacy.encrypt(JSON.stringify({ secret: true }));
        await writeLegacyDb(dbName, { s: legacyEntry(encrypted, { isEncrypted: true }) });
        const cache = makeCache({ dbName, encryptionKey: "pw", kdfIterations: 1000 });
        expect(await cache.get("s")).toEqual({ secret: true });
        // Rotation upgrades it to the per-database salt.
        expect(await cache.rotateKey("pw2")).toBe(1);
        expect((await cache.queryMeta())[0]?.keyId).toBeDefined();
        expect(await cache.get("s")).toEqual({ secret: true });
    });

    it("can be migrated eagerly (namespaces first) or dropped", async () => {
        const dbName = uniqueDb();
        await writeLegacyDb(dbName, {
            "users:1": legacyEntry('"a"'),
            "users:2": legacyEntry('"b"'),
            root: legacyEntry('"r"'),
            junk: { nope: true },
        });
        const users = makeCache({ dbName, namespace: "users" });
        expect(await users.migrateLegacy()).toBe(2);
        expect(await users.count()).toBe(2);
        const root = makeCache({ dbName });
        expect((await root.getHealth()).issues.join()).toContain("≤0.5");
        expect(await root.migrateLegacy()).toBe(1); // "junk" is malformed and dropped
        expect(await root.dropLegacyData()).toBe(0);
        expect((await root.getHealth()).issues).toEqual([]);
    });

    it("legacy: 'ignore' never reads old data", async () => {
        const dbName = uniqueDb();
        await writeLegacyDb(dbName, { k: legacyEntry('"old"') });
        const cache = makeCache({ dbName, legacy: "ignore" });
        expect(await cache.get("k")).toBeNull();
        expect(await cache.dropLegacyData()).toBe(1);
    });
});
