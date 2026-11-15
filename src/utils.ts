// ==============================
// CacheCraft Utils
// SSR-safe, cross-browser (Chrome/Firefox/Safari + mobile)
// ==============================

import { UnsupportedEnvironmentError } from "./errors";

export { base64ToBytes, bytesToBase64 } from "./base64";
export {
    compress,
    compressBytes,
    decompress,
    decompressBytes,
    isCompressionSupported,
    isGzip,
} from "./compression";
export { EncryptionManager, isWebCryptoAvailable } from "./crypto";
export { optionalDuration, parseDuration, parseSize } from "./duration";
export {
    CacheError,
    EncryptionError,
    QuotaExceededError,
    SchemaValidationError,
    TimeoutError,
    toError,
    UnsupportedEnvironmentError,
} from "./errors";
export { calculateTTL, getAge, getTimeUntilExpiry, isExpired } from "./time";

/** Library version, injected from package.json at build time. */
export const VERSION: string = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

// ==============================
// Environment Checks
// ==============================

/** True in a browser window with IndexedDB. */
export function isClient(): boolean {
    return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

/** True when there is no `window` (server, edge runtime — or a Web Worker). */
export function isSSR(): boolean {
    return typeof window === "undefined";
}

export function isBroadcastChannelSupported(): boolean {
    return typeof BroadcastChannel !== "undefined";
}

/** Detect Safari (including iOS Safari and WKWebView). */
export function isSafari(): boolean {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent;
    return (
        /^((?!chrome|android).)*safari/i.test(ua) ||
        (/iPad|iPhone|iPod/.test(ua) && typeof window !== "undefined" && !("MSStream" in window))
    );
}

// ==============================
// Legacy Base64 "encoding" (the `encode: true` option)
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

/** Base64 of the URI-encoded text (the `encode: true` storage format). */
export function encodeLegacyBase64(text: string): string {
    return toBase64(encodeURIComponent(text));
}

export function decodeLegacyBase64(text: string): string {
    return decodeURIComponent(fromBase64(text));
}

/** @deprecated Obfuscation only — not encryption. */
export function encode(v: unknown): string {
    return encodeLegacyBase64(JSON.stringify(v));
}

/** @deprecated Obfuscation only — not encryption. */
export function decode(v: string): unknown {
    return JSON.parse(decodeLegacyBase64(v));
}

// ==============================
// Size Calculation
// ==============================

/** UTF-8 byte length of a string without allocating an encoded copy. */
export function utf8ByteLength(str: string): number {
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
    let json: string | undefined;
    try {
        json = JSON.stringify(data);
    } catch {
        return 0; // BigInt / cycles
    }
    return json === undefined ? 0 : utf8ByteLength(json);
}

// ==============================
// Key Utilities
// ==============================

/** @deprecated Namespaces are stored separately since 1.0; kept for custom tooling. */
export function buildKey(namespace: string, key: string): string {
    return namespace ? `${namespace}:${key}` : key;
}

/** @deprecated See {@link buildKey}. */
export function parseKey(fullKey: string, namespace: string): string {
    if (!namespace) return fullKey;
    const prefix = `${namespace}:`;
    return fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
}

/** `RegExp` test (stateless even for /g and /y) or substring match. */
export function matchesPattern(key: string, pattern: RegExp | string): boolean {
    if (pattern instanceof RegExp) {
        pattern.lastIndex = 0;
        return pattern.test(key);
    }
    return key.includes(pattern);
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
    if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
    return `${(ms / 86_400_000).toFixed(1)}d`;
}

export function formatPercentage(value: number): string {
    return `${(value * 100).toFixed(2)}%`;
}

// ==============================
// Performance Monitoring
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
// Deep Clone / IDs
// ==============================

export function deepClone<T>(obj: T): T {
    if (typeof structuredClone !== "undefined") return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj)) as T;
}

export function generateId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

/** Keep timers from holding a Node process (SSR, tests) open. */
export function unref(handle: unknown): void {
    (handle as { unref?: () => void } | null)?.unref?.();
}
