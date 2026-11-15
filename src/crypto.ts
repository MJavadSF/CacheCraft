import { base64ToBytes, bytesToBase64 } from "./base64";
import { EncryptionError, toError } from "./errors";

// ==============================
// Encryption (AES-GCM-256 via Web Crypto)
//
// • Passphrases are stretched with PBKDF2-SHA-256 (600 000 iterations by default)
//   and a random per-database salt stored in the database's system store.
// • Every entry records the id of the key that encrypted it, so several keys can
//   coexist (rotation) and ≤0.5 entries (fixed salt, 100 000 iterations) stay readable.
// • A key id is a fingerprint (AES of a zero block) — it reveals nothing about the key.
// • Derived keys are cached per (salt, iterations, passphrase): namespaces and
//   engines sharing a passphrase derive it once.
// ==============================

export const DEFAULT_KDF_ITERATIONS = 600_000;
const LEGACY_SALT = "cachecraft-salt-v3";
const LEGACY_ITERATIONS = 100_000;
const IV_LENGTH = 12;

export type KeySource = string | CryptoKey;

export function isWebCryptoAvailable(): boolean {
    return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
}

function requireWebCrypto(): void {
    if (!isWebCryptoAvailable()) {
        throw new EncryptionError("Web Crypto API not available in this environment");
    }
}

const derivedKeys = new Map<string, Promise<CryptoKey>>();

/** PBKDF2-SHA-256 → AES-GCM-256, memoised. */
export function deriveKey(
    passphrase: string,
    salt: Uint8Array,
    iterations: number
): Promise<CryptoKey> {
    requireWebCrypto();
    const cacheKey = `${iterations}|${bytesToBase64(salt)}|${passphrase}`;
    let pending = derivedKeys.get(cacheKey);
    if (!pending) {
        pending = (async () => {
            const material = await crypto.subtle.importKey(
                "raw",
                new TextEncoder().encode(passphrase),
                "PBKDF2",
                false,
                ["deriveKey"]
            );
            return crypto.subtle.deriveKey(
                {
                    name: "PBKDF2",
                    salt: salt as Uint8Array<ArrayBuffer>,
                    iterations,
                    hash: "SHA-256",
                },
                material,
                { name: "AES-GCM", length: 256 },
                false,
                ["encrypt", "decrypt"]
            );
        })();
        pending.catch(() => derivedKeys.delete(cacheKey));
        derivedKeys.set(cacheKey, pending);
    }
    return pending;
}

const fingerprints = new WeakMap<CryptoKey, Promise<string>>();

/** Stable, non-reversible identifier of an AES-GCM key. */
export function keyFingerprint(key: CryptoKey): Promise<string> {
    let pending = fingerprints.get(key);
    if (!pending) {
        pending = crypto.subtle
            .encrypt({ name: "AES-GCM", iv: new Uint8Array(IV_LENGTH) }, key, new Uint8Array(16))
            .then((buf) =>
                bytesToBase64(new Uint8Array(buf).subarray(0, 9))
                    .replace(/\+/g, "-")
                    .replace(/\//g, "_")
            );
        fingerprints.set(key, pending);
    }
    return pending;
}

export async function aesEncrypt(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        plain as Uint8Array<ArrayBuffer>
    );
    const out = new Uint8Array(IV_LENGTH + encrypted.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(encrypted), IV_LENGTH);
    return out;
}

export async function aesDecrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: data.slice(0, IV_LENGTH) },
        key,
        data.slice(IV_LENGTH)
    );
    return new Uint8Array(decrypted);
}

type ResolvedKey = { id: string; key: CryptoKey };

/**
 * The set of keys an engine can use: one primary (for writing) plus any number
 * of decryption-only keys.
 */
export class KeyRing {
    private primarySource: KeySource | undefined;
    private readonly others: KeySource[];
    private resolved: Promise<ResolvedKey[]> | null = null;
    private legacy: Promise<CryptoKey[]> | null = null;

    constructor(
        primary: KeySource | undefined,
        others: readonly KeySource[],
        private readonly iterations: number,
        private readonly getSalt: () => Promise<Uint8Array>
    ) {
        this.primarySource = primary;
        this.others = [...others];
    }

    get hasKey(): boolean {
        return this.primarySource !== undefined;
    }

    /** Make `source` the primary key; the previous one stays available for decryption. */
    setPrimary(source: KeySource): void {
        if (this.primarySource !== undefined) this.others.unshift(this.primarySource);
        this.primarySource = source;
        this.resolved = null;
        this.legacy = null;
    }

    /** Derive / fingerprint every key once. */
    private resolveAll(): Promise<ResolvedKey[]> {
        if (!this.resolved) {
            const sources = [
                ...(this.primarySource !== undefined ? [this.primarySource] : []),
                ...this.others,
            ];
            this.resolved = (async () => {
                requireWebCrypto();
                const keys: ResolvedKey[] = [];
                for (const source of sources) {
                    const key =
                        typeof source === "string"
                            ? await deriveKey(source, await this.getSalt(), this.iterations)
                            : source;
                    keys.push({ id: await keyFingerprint(key), key });
                }
                return keys;
            })();
            this.resolved.catch(() => {
                this.resolved = null;
            });
        }
        return this.resolved;
    }

    /** The ≤0.5 keys (fixed salt, 100k iterations) for every passphrase we know. */
    private legacyKeys(): Promise<CryptoKey[]> {
        if (!this.legacy) {
            const passphrases = [this.primarySource, ...this.others].filter(
                (s): s is string => typeof s === "string"
            );
            const salt = new TextEncoder().encode(LEGACY_SALT);
            this.legacy = Promise.all(
                passphrases.map((p) => deriveKey(p, salt, LEGACY_ITERATIONS))
            );
        }
        return this.legacy;
    }

    async ready(): Promise<void> {
        if (this.hasKey) await this.resolveAll();
    }

    async encrypt(plain: Uint8Array): Promise<{ data: Uint8Array; keyId: string }> {
        if (!this.hasKey) {
            throw new EncryptionError(
                "Encryption was requested but no `encryptionKey` is configured"
            );
        }
        const [primary] = await this.resolveAll();
        if (!primary) throw new EncryptionError("No encryption key available");
        return { data: await aesEncrypt(primary.key, plain), keyId: primary.id };
    }

    /** Decrypt with the key that wrote the entry (`keyId`), or the ≤0.5 keys when absent. */
    async decrypt(data: Uint8Array, keyId: string | undefined): Promise<Uint8Array> {
        if (!this.hasKey && this.others.length === 0) {
            throw new EncryptionError(
                "This entry is encrypted but no `encryptionKey` is configured"
            );
        }
        const candidates =
            keyId === undefined
                ? await this.legacyKeys()
                : (await this.resolveAll()).filter((k) => k.id === keyId).map((k) => k.key);
        if (candidates.length === 0) {
            throw new EncryptionError(
                "No configured key matches this entry (was it written with another `encryptionKey`? add it to `decryptionKeys`)"
            );
        }
        let lastError: unknown;
        for (const key of candidates) {
            try {
                return await aesDecrypt(key, data);
            } catch (err) {
                lastError = err;
            }
        }
        throw new EncryptionError(
            "Failed to decrypt entry (wrong key or corrupted data)",
            toError(lastError)
        );
    }

    /** A ring with the same passphrases but another salt (importing foreign exports). */
    withSalt(salt: Uint8Array): KeyRing {
        return new KeyRing(this.primarySource, this.others, this.iterations, async () => salt);
    }
}

/** 16 random bytes, Base64. */
export function randomSalt(): string {
    return bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
}

export function decodeSalt(salt: string): Uint8Array {
    return base64ToBytes(salt);
}

// ==============================
// EncryptionManager — the ≤0.5 standalone helper, kept for compatibility.
// ==============================

/**
 * @deprecated Standalone helper from ≤0.5 (fixed salt, 100 000 iterations).
 * The engine now uses a per-database salt and 600 000 iterations.
 */
export class EncryptionManager {
    private key: CryptoKey | null = null;
    private initialized = false;
    private initPromise: Promise<void> | null = null;

    initialize(password: string): Promise<void> {
        if (this.initialized) return Promise.resolve();
        if (!this.initPromise) {
            this.initPromise = (async () => {
                requireWebCrypto();
                this.key = await deriveKey(
                    password,
                    new TextEncoder().encode(LEGACY_SALT),
                    LEGACY_ITERATIONS
                );
                this.initialized = true;
            })().catch((err) => {
                this.initPromise = null;
                throw err instanceof EncryptionError ? err : new EncryptionError(String(err));
            });
        }
        return this.initPromise;
    }

    async encrypt(data: string | Uint8Array): Promise<Uint8Array> {
        if (!this.key) throw new EncryptionError("Encryption key not initialized");
        return aesEncrypt(
            this.key,
            typeof data === "string" ? new TextEncoder().encode(data) : data
        );
    }

    async decryptBytes(data: Uint8Array): Promise<Uint8Array> {
        if (!this.key) throw new EncryptionError("Encryption key not initialized");
        try {
            return await aesDecrypt(this.key, data);
        } catch (err) {
            throw new EncryptionError(
                "Failed to decrypt entry (wrong encryptionKey or corrupted data)",
                toError(err)
            );
        }
    }

    async decrypt(data: Uint8Array): Promise<string> {
        return new TextDecoder().decode(await this.decryptBytes(data));
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    ready(): Promise<void> {
        return (
            this.initPromise ?? Promise.reject(new EncryptionError("Encryption not initialized"))
        );
    }
}
