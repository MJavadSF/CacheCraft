// ==============================
// Environment Check
// ==============================

export function isClient(): boolean {
    return (
        typeof window !== "undefined" &&
        "indexedDB" in window &&
        "CompressionStream" in window
    );
}

export function isBroadcastChannelSupported(): boolean {
    return typeof BroadcastChannel !== "undefined";
}

// ==============================
// Compression
// ==============================

export async function compress(data: string): Promise<Uint8Array> {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    await writer.write(new TextEncoder().encode(data));
    await writer.close();
    const out = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(out);
}

export async function decompress(data: Uint8Array): Promise<string> {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    // @ts-ignore
    await writer.write(data);
    await writer.close();
    const out = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(out);
}

// ==============================
// Encoding
// ==============================

export function encode(v: any): string {
    return btoa(encodeURIComponent(JSON.stringify(v)));
}

export function decode(v: string): any {
    return JSON.parse(decodeURIComponent(atob(v)));
}

// ==============================
// Encryption
// ==============================

export class EncryptionManager {
    private key: CryptoKey | null = null;
    private initialized = false;

    async initialize(password: string): Promise<void> {
        if (this.initialized) return;

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
                salt: enc.encode("cachecraft-salt-v2"),
                iterations: 100000,
                hash: "SHA-256",
            },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"]
        );

        this.initialized = true;
    }

    async encrypt(data: string): Promise<Uint8Array> {
        if (!this.key) throw new Error("Encryption key not initialized");

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(data);

        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            this.key,
            encoded
        );

        const result = new Uint8Array(iv.length + encrypted.byteLength);
        result.set(iv, 0);
        result.set(new Uint8Array(encrypted), iv.length);

        return result;
    }

    async decrypt(data: Uint8Array): Promise<string> {
        if (!this.key) throw new Error("Encryption key not initialized");

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

export function getSize(data: any): number {
    if (data instanceof Uint8Array) {
        return data.byteLength;
    }
    if (data instanceof ArrayBuffer) {
        return data.byteLength;
    }
    if (typeof data === "string") {
        return new Blob([data]).size;
    }
    return new Blob([JSON.stringify(data)]).size;
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
        return pattern.test(key);
    }
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
    if (!ttl) return undefined;
    return Date.now() + ttl;
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
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
}

export function formatPercentage(value: number): string {
    return `${(value * 100).toFixed(2)}%`;
}

// ==============================
// Error Handling
// ==============================

export class CacheError extends Error {
    constructor(
        message: string,
        public code: string,
        public originalError?: Error
    ) {
        super(message);
        this.name = "CacheError";
    }
}

export class QuotaExceededError extends CacheError {
    constructor(message = "Storage quota exceeded") {
        super(message, "QUOTA_EXCEEDED");
        this.name = "QuotaExceededError";
    }
}

export class EncryptionError extends CacheError {
    constructor(message: string, originalError?: Error) {
        super(message, "ENCRYPTION_ERROR", originalError);
        this.name = "EncryptionError";
    }
}

// ==============================
// Performance Monitoring
// ==============================

export class PerformanceTimer {
    private startTime: number;

    constructor() {
        this.startTime = performance.now();
    }

    elapsed(): number {
        return performance.now() - this.startTime;
    }

    reset(): void {
        this.startTime = performance.now();
    }
}

// ==============================
// Debounce & Throttle
// ==============================

export function debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout | null = null;

    return function (...args: Parameters<T>) {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

export function throttle<T extends (...args: any[]) => any>(
    func: T,
    limit: number
): (...args: Parameters<T>) => void {
    let inThrottle: boolean;

    return function (...args: Parameters<T>) {
        if (!inThrottle) {
            func(...args);
            inThrottle = true;
            setTimeout(() => (inThrottle = false), limit);
        }
    };
}

// ==============================
// Deep Clone
// ==============================

export function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
}

// ==============================
// UUID Generator
// ==============================

export function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
