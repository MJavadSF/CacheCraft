import { describe, expect, it } from "vitest";
import {
    compress,
    decode,
    decompress,
    EncryptionManager,
    encode,
    formatBytes,
    getSize,
    matchesPattern,
    parseKey,
    VERSION,
} from "../src";

describe("compression", () => {
    it("round-trips text", async () => {
        const text = JSON.stringify({ a: "hello ".repeat(1000), n: 42 });
        expect(await decompress(await compress(text))).toBe(text);
    });

    it("does not deadlock on large incompressible payloads", async () => {
        // ~6 MB of random text: the previous write-then-read pattern hung forever here.
        const bytes = new Uint8Array(6_000_000);
        for (let i = 0; i < bytes.length; i += 65_536) {
            crypto.getRandomValues(bytes.subarray(i, i + 65_536));
        }
        let big = "";
        for (let i = 0; i < bytes.length; i += 30_000) {
            big += String.fromCharCode(
                ...Array.from(bytes.subarray(i, i + 30_000), (b) => 33 + (b % 90))
            );
        }
        const packed = await compress(big);
        expect(await decompress(packed)).toBe(big);
    }, 20_000);

    it("decompress passes through non-gzip bytes (identity fallback data)", async () => {
        const raw = new TextEncoder().encode("plain text");
        expect(await decompress(raw)).toBe("plain text");
    });
});

describe("encode / decode", () => {
    it("round-trips unicode", () => {
        const value = { fa: "سلام دنیا", emoji: "🚀", n: [1, 2, 3] };
        expect(decode(encode(value))).toEqual(value);
    });
});

describe("getSize", () => {
    it("counts UTF-8 bytes, including surrogate pairs", () => {
        expect(getSize("abc")).toBe(3);
        expect(getSize("é")).toBe(2);
        expect(getSize("€")).toBe(3);
        expect(getSize("🚀")).toBe(4);
        expect(getSize("🚀")).toBe(new TextEncoder().encode("🚀").byteLength);
    });

    it("handles values without a JSON form", () => {
        expect(getSize(undefined)).toBe(0);
        expect(getSize({ a: 1 })).toBe(7);
        expect(getSize(new Uint8Array(5))).toBe(5);
    });
});

describe("matchesPattern", () => {
    it("is stable for global regexes (no lastIndex alternation)", () => {
        const re = /user:/g;
        expect([1, 2, 3, 4].map(() => matchesPattern("user:1", re))).toEqual([
            true,
            true,
            true,
            true,
        ]);
    });
});

describe("misc utils", () => {
    it("parseKey strips only the matching namespace", () => {
        expect(parseKey("ns:key", "ns")).toBe("key");
        expect(parseKey("other:key", "ns")).toBe("other:key");
    });

    it("formatBytes never goes negative or NaN", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(-5)).toBe("0 B");
        expect(formatBytes(0.5)).toBe("0.50 B");
        expect(formatBytes(1536)).toBe("1.50 KB");
    });

    it("exposes the package version", () => {
        expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    });
});

describe("EncryptionManager", () => {
    it("encrypts/decrypts strings and bytes", async () => {
        const m = new EncryptionManager();
        await m.initialize("secret");
        expect(await m.decrypt(await m.encrypt("héllo"))).toBe("héllo");
        const bytes = new Uint8Array([1, 2, 3, 250]);
        expect(await m.decryptBytes(await m.encrypt(bytes))).toEqual(bytes);
    });

    it("concurrent initialize calls share one derivation", async () => {
        const m = new EncryptionManager();
        await Promise.all([m.initialize("k"), m.initialize("k"), m.initialize("k")]);
        expect(m.isInitialized()).toBe(true);
    });

    it("wraps a wrong-key failure in EncryptionError", async () => {
        const a = new EncryptionManager();
        const b = new EncryptionManager();
        await a.initialize("one");
        await b.initialize("two");
        await expect(b.decrypt(await a.encrypt("x"))).rejects.toMatchObject({
            code: "ENCRYPTION_ERROR",
        });
    });
});
