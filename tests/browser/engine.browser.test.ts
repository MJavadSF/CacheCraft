import { afterEach, describe, expect, it } from "vitest";
import {
    CacheEngine,
    EncryptionManager,
    IndexedDBAdapter,
    isOPFSSupported,
    OPFSAdapter,
} from "../../src";
import { mountDevtools } from "../../src/devtools";
import { acquireLeadership } from "../../src/locks";
import { adapterContract } from "../shared/adapter-contract";

let n = 0;
const db = (): string => `browser-${Date.now()}-${++n}`;
const engines: CacheEngine[] = [];
function make(config: ConstructorParameters<typeof CacheEngine>[0] = {}): CacheEngine {
    const e = new CacheEngine({ dbName: db(), autoCleanup: false, ...config });
    engines.push(e);
    return e;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
    await Promise.all(engines.splice(0).map((e) => e.destroy()));
});

adapterContract("indexeddb (real browser)", () => new IndexedDBAdapter(db(), "cache"));
if (isOPFSSupported()) adapterContract("opfs (real browser)", () => new OPFSAdapter(db(), "cache"));

describe("real browser", () => {
    it("has the platform features CacheCraft relies on", () => {
        expect(typeof indexedDB).toBe("object");
        expect(typeof CompressionStream).toBe("function");
        expect(typeof BroadcastChannel).toBe("function");
        expect(typeof navigator.locks?.request).toBe("function");
        expect(isOPFSSupported()).toBe(true);
    });

    it("keeps two engines coherent through BroadcastChannel (incl. memory tiers)", async () => {
        const dbName = db();
        const a = make({ dbName, memoryCache: true });
        const b = make({ dbName, memoryCache: true });
        await a.set("k", 1);
        expect(await b.get("k")).toBe(1);
        await a.set("k", 2);
        await sleep(50);
        expect(await b.get("k")).toBe(2); // b's memory tier was invalidated by sync
        await a.remove("k");
        await sleep(50);
        expect(await b.count()).toBe(0);
    });

    it("single-flights getOrSet across engines (tabs) with Web Locks", async () => {
        const dbName = db();
        const a = make({ dbName });
        const b = make({ dbName });
        let calls = 0;
        const factory = async (): Promise<string> => {
            calls++;
            await sleep(50);
            return "v";
        };
        const [x, y] = await Promise.all([
            a.getOrSet("k", factory, { crossTab: true }),
            b.getOrSet("k", factory, { crossTab: true }),
        ]);
        expect([x, y]).toEqual(["v", "v"]);
        expect(calls).toBe(1);
    });

    it("elects a single cleanup leader", async () => {
        const name = `leader-${db()}`;
        const leaders: string[] = [];
        const release1 = acquireLeadership(name, () => leaders.push("one"));
        const release2 = acquireLeadership(name, () => leaders.push("two"));
        await sleep(30);
        expect(leaders).toEqual(["one"]);
        release1();
        await sleep(30);
        expect(leaders).toEqual(["one", "two"]);
        release2();
    });

    it("compresses multi-megabyte incompressible payloads without deadlocking", async () => {
        const cache = make({ compression: { threshold: 1024 } });
        const bytes = crypto.getRandomValues(new Uint8Array(65_536));
        const big = Array.from({ length: 64 }, () => btoa(String.fromCharCode(...bytes))).join("");
        await cache.set("big", big, { forceCompress: true });
        expect(await cache.get("big")).toBe(big);
    });

    it("encrypts with the default 600k-iteration KDF and decrypts after a reload", async () => {
        const dbName = db();
        const a = make({ dbName, encryptionKey: "correct horse" });
        const started = performance.now();
        await a.set("s", { pin: 1234 }, { encrypt: true });
        const elapsed = performance.now() - started;
        await a.destroy();
        const b = make({ dbName, encryptionKey: "correct horse" });
        expect(await b.get("s")).toEqual({ pin: 1234 });
        expect(elapsed).toBeLessThan(5000);
    });

    it("migrates a real ≤0.5 database in place", async () => {
        const dbName = db();
        const legacy = new EncryptionManager();
        await legacy.initialize("pw");
        const cipher = await legacy.encrypt(JSON.stringify("secret"));
        await new Promise<void>((resolve) => {
            const req = indexedDB.open(dbName, 1);
            req.onupgradeneeded = () => req.result.createObjectStore("cache");
            req.onsuccess = () => {
                const tx = req.result.transaction("cache", "readwrite");
                const now = Date.now();
                const base = {
                    isEncoded: false,
                    isCompressed: false,
                    createdAt: now,
                    lastAccessed: now,
                    accessCount: 0,
                    tags: [],
                };
                tx.objectStore("cache").put({ ...base, value: '"plain"', size: 7 }, "a");
                tx.objectStore("cache").put(
                    { ...base, value: cipher, size: cipher.byteLength, isEncrypted: true },
                    "ns:b"
                );
                tx.oncomplete = () => {
                    req.result.close();
                    resolve();
                };
            };
        });
        const root = make({ dbName, encryptionKey: "pw" });
        const ns = make({ dbName, namespace: "ns", encryptionKey: "pw" });
        expect(await root.get("a")).toBe("plain");
        expect(await ns.get("b")).toBe("secret");
    });

    it("stores blobs and large binary data in OPFS", async () => {
        const cache = make({ storage: "opfs" });
        const payload = new Uint8Array(1_000_000);
        for (let i = 0; i < payload.length; i += 65_536)
            crypto.getRandomValues(payload.subarray(i, i + 65_536));
        await cache.setBlob("img", new Blob([payload], { type: "image/webp" }));
        await cache.set("json", { a: [1, 2, 3], d: new Date(0) });
        const blob = await cache.getBlob("img");
        expect(blob?.type).toBe("image/webp");
        expect(new Uint8Array((await blob?.arrayBuffer()) as ArrayBuffer)).toEqual(payload);
        expect(await cache.get("json")).toEqual({ a: [1, 2, 3], d: new Date(0) });
        const reloaded = make({ dbName: cache.info.dbName, storage: "opfs" });
        expect(await reloaded.count()).toBe(2);
        await cache.clear();
    });

    it("OPFS reads never fail while another engine rewrites the same files", async () => {
        const dbName = db();
        const writer = make({ dbName, storage: "opfs", persistAccessMetadata: false });
        for (let i = 0; i < 10; i++) await writer.set(`k${i}`, { i, pad: "x".repeat(2000) });
        const readers = Array.from({ length: 3 }, () => new OPFSAdapter(dbName, "cache"));
        const writes = (async () => {
            for (let round = 0; round < 15; round++) {
                for (let i = 0; i < 10; i++) await writer.touch(`k${i}`, "1h");
            }
        })();
        const reads = readers.map(async (r) => {
            for (let round = 0; round < 15; round++) {
                expect((await r.loadMeta("")).length).toBe(10);
                expect((await r.get("", ["k3"])).size).toBe(1);
            }
        });
        await Promise.all([writes, ...reads]);
        await writer.clear();
    });

    it("renders the devtools panel", async () => {
        const cache = make({ label: "Browser cache" });
        await cache.set("k", { a: 1 });
        const devtools = mountDevtools({ engines: [cache], initialIsOpen: true });
        await sleep(100);
        const host = document.querySelector("[data-cachecraft-devtools]");
        expect(host?.shadowRoot?.textContent).toContain("Browser cache");
        const panel = host?.shadowRoot?.querySelector(".cc-panel") as HTMLElement;
        expect(panel.getBoundingClientRect().height).toBeGreaterThan(100);
        devtools.destroy();
    });
});
