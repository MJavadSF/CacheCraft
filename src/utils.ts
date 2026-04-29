// ==============================
// CacheCraft Utils — v0.3
// SSR-safe, cross-browser (Chrome/Firefox/Safari + mobile)
// ==============================

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
    return (
        typeof crypto !== "undefined" &&
        typeof crypto.subtle !== "undefined"
    );
}

/** Detect Safari (including iOS Safari and WKWebView) */
export function isSafari(): boolean {
    if (typeof navigator === "undefined") return false;
    return (
        /^((?!chrome|android).)*safari/i.test(navigator.userAgent) ||
        // iOS Chrome / Edge also use WebKit
        (/iPad|iPhone|iPod/.test(navigator.userAgent) && !("MSStream" in window))
    );
}

// ==============================
// Compression
// Streams API: Chrome 80+, Firefox 113+, Safari 16.4+
// Falls back to identity (no compression) in unsupported environments
// ==============================

export async function compress(data: string): Promise<Uint8Array> {
    if (typeof CompressionStream === "undefined") {
        // Fallback: store as raw UTF-8 bytes without compression
        return new TextEncoder().encode(data);
    }

    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    await writer.write(new TextEncoder().encode(data));
    await writer.close();

    const buffer = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(buffer);
}

export async function decompress(data: Uint8Array): Promise<string> {
    if (typeof DecompressionStream === "undefined") {
        // Matching fallback: data is stored as raw UTF-8
        return new TextDecoder().decode(data);
    }

    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    // @ts-ignore
    await writer.write(data);
    await writer.close();

    const buffer = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(buffer);
}

// ==============================
// Encoding (Base64 URL-safe, works in all environments)
// ==============================

export function encode(v: unknown): string {
    const json = JSON.stringify(v);
    if (typeof btoa !== "undefined") {
        return btoa(encodeURIComponent(json));
    }
    // Node / Edge runtime fallback
    return Buffer.from(json, "utf8").toString("base64");
}

export function decode(v: string): unknown {
    if (typeof atob !== "undefined") {
        return JSON.parse(decodeURIComponent(atob(v)));
    }
    return JSON.parse(Buffer.from(v, "base64").toString("utf8"));
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

    async initialize(password: string): Promise<void> {
        if (this.initialized) return;

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

    async encrypt(data: string): Promise<Uint8Array> {
        if (!this.key) throw new EncryptionError("Encryption key not initialized");

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(data);

        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            this.key,
            encoded
        );

        // Prepend IV to ciphertext
        const result = new Uint8Array(iv.length + encrypted.byteLength);
        result.set(iv, 0);
        result.set(new Uint8Array(encrypted), iv.length);
        return result;
    }

    async decrypt(data: Uint8Array): Promise<string> {
        if (!this.key) throw new EncryptionError("Encryption key not initialized");

        const iv = data.slice(0, 12);
        const encrypted = data.slice(12);

        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            this.key,
            encrypted
        );

        return new TextDecoder().decode(decrypted);
    }

    isInitialized(): boolean {
        return this.initialized;
    }
}

// ==============================
// Size Calculation
// ==============================

export function getSize(data: unknown): number {
    if (data instanceof Uint8Array) return data.byteLength;
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (typeof data === "string") {
        // TextEncoder is available in all modern environments
        if (typeof TextEncoder !== "undefined") {
            return new TextEncoder().encode(data).byteLength;
        }
        // Fallback: approximate byte count (UTF-16 surrogate pairs are 4 bytes)
        return new Blob([data]).size;
    }
    return getSize(JSON.stringify(data));
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
    if (pattern instanceof RegExp) return pattern.test(key);
    return key.includes(pattern);
}

// ==============================
// Time Utilities
// ==============================

export function isExpired(expiresAt: number | undefined): boolean {
    if (!expiresAt) return false;
    return Date.now() > expiresAt;
}

export function calculateTTL(ttl: number | undefined): number | undefined {
    return ttl !== undefined ? Date.now() + ttl : undefined;
}

export function getAge(createdAt: number): number {
    return Date.now() - createdAt;
}

export function getTimeUntilExpiry(expiresAt: number | undefined): number | null {
    if (!expiresAt) return null;
    const remaining = expiresAt - Date.now();
    return remaining > 0 ? remaining : 0;
}

// ==============================
// Format Utilities
// ==============================

export function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"] as const;
    const i = Math.min(
        Math.floor(Math.log(bytes) / Math.log(k)),
        sizes.length - 1
    );
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
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
    constructor(message = "Storage quota exceeded") {
        super(message, "QUOTA_EXCEEDED");
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
        return typeof performance !== "undefined"
            ? performance.now()
            : Date.now();
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

export function debounce<T extends (...args: unknown[]) => unknown>(
    func: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return function (...args: Parameters<T>) {
        if (timeout !== null) clearTimeout(timeout);
        timeout = setTimeout(() => {
            timeout = null;
            func(...args);
        }, wait);
    };
}

export function throttle<T extends (...args: unknown[]) => unknown>(
    func: T,
    limit: number
): (...args: Parameters<T>) => void {
    let inThrottle = false;
    return function (...args: Parameters<T>) {
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
    if (
        typeof crypto !== "undefined" &&
        typeof (crypto as Crypto & { randomUUID?: () => string }).randomUUID === "function"
    ) {
        return (crypto as Crypto & { randomUUID: () => string }).randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}
