// ==============================
// CacheCraft Utils
// SSR-safe, cross-browser (Chrome/Firefox/Safari + mobile)
// ==============================

/** Library version, injected from package.json at build time. */
export const VERSION: string = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

/** Normalise anything thrown into a real `Error`. */
export function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

// ==============================
// Environment Checks
// ==============================

/** True only in a browser context with full IndexedDB + Streams support */
export function isClient(): boolean {
    return (
        typeof window !== "undefined" &&
        typeof indexedDB !== "undefined" &&
        typeof CompressionStream !== "undefined"
    );
}

/** True when running in any JS environment (browser, Node, Edge runtime) */
export function isSSR(): boolean {
    return typeof window === "undefined";
}

export function isBroadcastChannelSupported(): boolean {
    return typeof BroadcastChannel !== "undefined";
}

export function isWebCryptoAvailable(): boolean {
    return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
}

/** Detect Safari (including iOS Safari and WKWebView) */
export function isSafari(): boolean {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent;
    return (
        /^((?!chrome|android).)*safari/i.test(ua) ||
        // iOS Chrome / Edge also use WebKit
        (/iPad|iPhone|iPod/.test(ua) && typeof window !== "undefined" && !("MSStream" in window))
    );
}

// ==============================
// Compression
// Streams API: Chrome 80+, Firefox 113+, Safari 16.4+
// Falls back to identity (no compression) in unsupported environments
// ==============================

type StreamPair = {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<BufferSource>;
};

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
    }
    if (chunks.length === 1) return chunks[0] as Uint8Array;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/**
 * Push `input` through a (De)CompressionStream.
 *
 * The writer and the reader MUST run concurrently: awaiting `write()` before
 * anyone reads from the readable side deadlocks once the output exceeds the
 * stream's internal buffer (large / incompressible payloads).
 */
async function runStream(pair: StreamPair, input: Uint8Array): Promise<Uint8Array> {
    const writer = pair.writable.getWriter();
    const writing = writer.write(input as Uint8Array<ArrayBuffer>).then(() => writer.close());
    // Failures surface through the readable side below; avoid an unhandled rejection.
    writing.catch(() => undefined);
    const out = await readAll(pair.readable);
    await writing;
    return out;
}

export async function compress(data: string): Promise<Uint8Array> {
    const bytes = new TextEncoder().encode(data);
    if (typeof CompressionStream === "undefined") {
        // Fallback: store as raw UTF-8 bytes without compression
        return bytes;
    }
    return runStream(new CompressionStream("gzip"), bytes);
}

/** True when the bytes start with the gzip magic number (0x1f 0x8b). */
export function isGzip(data: Uint8Array): boolean {
    return data.byteLength > 2 && data[0] === 0x1f && data[1] === 0x8b;
}

export async function decompress(data: Uint8Array): Promise<string> {
    // Not a gzip stream? It was written by the identity fallback.
    if (typeof DecompressionStream === "undefined" || !isGzip(data)) {
        return new TextDecoder().decode(data);
    }
    return new TextDecoder().decode(await runStream(new DecompressionStream("gzip"), data));
}

// ==============================
// Encoding (standard Base64 of the URI-encoded JSON; identical in every environment)
// ==============================

type NodeBufferLike = {
    from(input: string, encoding: string): { toString(encoding: string): string };
};

function nodeBuffer(): NodeBufferLike | undefined {
    return (globalThis as { Buffer?: NodeBufferLike }).Buffer;
}

function toBase64(ascii: string): string {
    if (typeof btoa === "function") return btoa(ascii);
    const buffer = nodeBuffer();
    if (buffer) return buffer.from(ascii, "latin1").toString("base64");
    throw new UnsupportedEnvironmentError("No Base64 encoder available in this environment");
}

function fromBase64(base64: string): string {
    if (typeof atob === "function") return atob(base64);
    const buffer = nodeBuffer();
    if (buffer) return buffer.from(base64, "base64").toString("latin1");
    throw new UnsupportedEnvironmentError("No Base64 decoder available in this environment");
}

export function encode(v: unknown): string {
    return toBase64(encodeURIComponent(JSON.stringify(v)));
}

export function decode(v: string): unknown {
    return JSON.parse(decodeURIComponent(fromBase64(v)));
}

// ==============================
// Encryption  (Web Crypto — available in all modern browsers + Node 15+)
// Safari 15+, Chrome 37+, Firefox 34+
// ==============================

const SALT = "cachecraft-salt-v3";
const PBKDF2_ITERATIONS = 100_000;

export class EncryptionManager {
    private key: CryptoKey | null = null;
    private initialized = false;
    private initPromise: Promise<void> | null = null;

    initialize(password: string): Promise<void> {
        if (this.initialized) return Promise.resolve();
        if (!this.initPromise) {
            this.initPromise = this.derive(password).catch((err) => {
                this.initPromise = null; // allow a retry
                throw err;
            });
        }
        return this.initPromise;
    }

    private async derive(password: string): Promise<void> {
        if (!isWebCryptoAvailable()) {
            throw new EncryptionError("Web Crypto API not available in this environment");
        }

        const enc = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            "raw",
            enc.encode(password),
            "PBKDF2",
            false,
            ["deriveBits", "deriveKey"]
        );

        this.key = await crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: enc.encode(SALT),
                iterations: PBKDF2_ITERATIONS,
                hash: "SHA-256",
            },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            false, // non-extractable
            ["encrypt", "decrypt"]
        );

        this.initialized = true;
    }

    /** Encrypt a string (UTF-8) or raw bytes. Output = 12-byte IV + ciphertext. */
    async encrypt(data: string | Uint8Array): Promise<Uint8Array> {
        if (!this.key) throw new EncryptionError("Encryption key not initialized");

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plain = typeof data === "string" ? new TextEncoder().encode(data) : data;

        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            this.key,
            plain as Uint8Array<ArrayBuffer>
        );

        // Prepend IV to ciphertext
        const result = new Uint8Array(iv.length + encrypted.byteLength);
        result.set(iv, 0);
        result.set(new Uint8Array(encrypted), iv.length);
        return result;
    }

    async decryptBytes(data: Uint8Array): Promise<Uint8Array> {
        if (!this.key) throw new EncryptionError("Encryption key not initialized");

        const iv = data.slice(0, 12);
        const encrypted = data.slice(12);

        try {
            const decrypted = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv },
                this.key,
                encrypted
            );
            return new Uint8Array(decrypted);
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

    /** Resolves once the key is derived; rejects if derivation failed. */
    ready(): Promise<void> {
        return (
            this.initPromise ?? Promise.reject(new EncryptionError("Encryption not initialized"))
        );
    }
}

// ==============================
// Size Calculation
// ==============================

/** UTF-8 byte length of a string without allocating an encoded copy. */
function utf8ByteLength(str: string): number {
    let bytes = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c < 0x80) {
            bytes += 1;
        } else if (c < 0x800) {
            bytes += 2;
        } else if (c >= 0xd800 && c <= 0xdbff && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
            bytes += 4; // surrogate pair
            i++;
        } else {
            bytes += 3;
        }
    }
    return bytes;
}

export function getSize(data: unknown): number {
    if (data instanceof Uint8Array) return data.byteLength;
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (typeof data === "string") return utf8ByteLength(data);
    // `undefined`, functions and symbols have no JSON form.
    const json = JSON.stringify(data);
    return json === undefined ? 0 : utf8ByteLength(json);
}

// ==============================
// Key Utilities
// ==============================

export function buildKey(namespace: string, key: string): string {
    return namespace ? `${namespace}:${key}` : key;
}

export function parseKey(fullKey: string, namespace: string): string {
    if (!namespace) return fullKey;
    const prefix = `${namespace}:`;
    return fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
}

export function matchesPattern(key: string, pattern: RegExp | string): boolean {
    if (pattern instanceof RegExp) {
        // Global / sticky regexes are stateful (`lastIndex`) and give alternating results.
        pattern.lastIndex = 0;
        return pattern.test(key);
    }
    return key.includes(pattern);
}

// ==============================
// Time Utilities
// ==============================

export function isExpired(expiresAt: number | undefined): boolean {
    if (expiresAt === undefined) return false;
    return Date.now() > expiresAt;
}

export function calculateTTL(ttl: number | undefined): number | undefined {
    return ttl !== undefined ? Date.now() + ttl : undefined;
}

export function getAge(createdAt: number): number {
    return Date.now() - createdAt;
}

export function getTimeUntilExpiry(expiresAt: number | undefined): number | null {
    if (expiresAt === undefined) return null;
    const remaining = expiresAt - Date.now();
    return remaining > 0 ? remaining : 0;
}

// ==============================
// Format Utilities
// ==============================

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"] as const;
    const i = Math.min(Math.max(Math.floor(Math.log(bytes) / Math.log(k)), 0), sizes.length - 1);
    return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms * 100) / 100}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function formatPercentage(value: number): string {
    return `${(value * 100).toFixed(2)}%`;
}

// ==============================
// Error Classes
// ==============================

export class CacheError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly originalError?: Error
    ) {
        super(message);
        this.name = "CacheError";
        // Maintain proper prototype chain in transpiled ES5
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export class QuotaExceededError extends CacheError {
    constructor(message = "Storage quota exceeded", originalError?: Error) {
        super(message, "QUOTA_EXCEEDED", originalError);
        this.name = "QuotaExceededError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export class EncryptionError extends CacheError {
    constructor(message: string, originalError?: Error) {
        super(message, "ENCRYPTION_ERROR", originalError);
        this.name = "EncryptionError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export class UnsupportedEnvironmentError extends CacheError {
    constructor(message = "Operation not supported in this environment") {
        super(message, "UNSUPPORTED_ENV");
        this.name = "UnsupportedEnvironmentError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

// ==============================
// Performance Monitoring
// Uses performance.now() when available, falls back to Date.now()
// ==============================

export class PerformanceTimer {
    private startTime: number;

    constructor() {
        this.startTime = this.now();
    }

    private now(): number {
        return typeof performance !== "undefined" ? performance.now() : Date.now();
    }

    elapsed(): number {
        return this.now() - this.startTime;
    }

    reset(): void {
        this.startTime = this.now();
    }
}

// ==============================
// Debounce & Throttle
// ==============================

// biome-ignore lint/suspicious/noExplicitAny: `any[]` keeps typed callbacks assignable and `debounce<typeof fn>()` working
type AnyFunction = (...args: any[]) => unknown;

export function debounce<T extends AnyFunction>(
    func: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return (...args: Parameters<T>) => {
        if (timeout !== null) clearTimeout(timeout);
        timeout = setTimeout(() => {
            timeout = null;
            func(...args);
        }, wait);
    };
}

export function throttle<T extends AnyFunction>(
    func: T,
    limit: number
): (...args: Parameters<T>) => void {
    let inThrottle = false;
    return (...args: Parameters<T>) => {
        if (!inThrottle) {
            func(...args);
            inThrottle = true;
            setTimeout(() => {
                inThrottle = false;
            }, limit);
        }
    };
}

// ==============================
// Deep Clone
// Uses structuredClone when available (Chrome 98+, Firefox 94+, Safari 15.4+, Node 17+)
// Falls back to JSON round-trip
// ==============================

export function deepClone<T>(obj: T): T {
    if (typeof structuredClone !== "undefined") {
        return structuredClone(obj);
    }
    return JSON.parse(JSON.stringify(obj)) as T;
}

// ==============================
// UUID / ID Generation
// Uses crypto.randomUUID() when available; falls back to Date + Math.random
// ==============================

export function generateId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}
