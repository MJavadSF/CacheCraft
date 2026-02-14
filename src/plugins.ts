import { CachePlugin, CacheSetOptions, CacheGetOptions, CacheEntry } from "./types";

// ==============================
// Logger Plugin
// ==============================

export class LoggerPlugin implements CachePlugin {
    name = "logger";
    version = "1.0.0";
    private logger: (message: string) => void;

    constructor(logger?: (message: string) => void) {
        this.logger = logger || console.log;
    }

    afterSet(key: string, value: any, entry: CacheEntry): void {
        this.logger(`[CACHE] Set: ${key} (${entry.size} bytes)`);
    }

    afterGet(key: string, value: any, entry: CacheEntry | null): void {
        if (entry) {
            this.logger(`[CACHE] Hit: ${key}`);
        } else {
            this.logger(`[CACHE] Miss: ${key}`);
        }
    }

    afterDelete(key: string, existed: boolean): void {
        this.logger(`[CACHE] Delete: ${key} (existed: ${existed})`);
    }

    onEvict(keys: string[]): void {
        this.logger(`[CACHE] Evicted ${keys.length} entries: ${keys.join(", ")}`);
    }

    onError(error: Error, operation: string): void {
        this.logger(`[CACHE ERROR] ${operation}: ${error.message}`);
    }
}

// ==============================
// Metrics Plugin
// ==============================

export class MetricsPlugin implements CachePlugin {
    name = "metrics";
    version = "1.0.0";
    private metrics: Map<string, number> = new Map();

    afterSet(key: string): void {
        this.increment("sets");
        this.increment(`key:${key}:sets`);
    }

    afterGet(key: string, value: any, entry: CacheEntry | null): void {
        if (entry) {
            this.increment("hits");
            this.increment(`key:${key}:hits`);
        } else {
            this.increment("misses");
            this.increment(`key:${key}:misses`);
        }
    }

    afterDelete(key: string, existed: boolean): void {
        if (existed) {
            this.increment("deletes");
            this.increment(`key:${key}:deletes`);
        }
    }

    onEvict(keys: string[]): void {
        this.increment("evictions", keys.length);
    }

    onError(): void {
        this.increment("errors");
    }

    private increment(metric: string, by = 1): void {
        const current = this.metrics.get(metric) || 0;
        this.metrics.set(metric, current + by);
    }

    getMetric(metric: string): number {
        return this.metrics.get(metric) || 0;
    }

    getAllMetrics(): Record<string, number> {
        return Object.fromEntries(this.metrics.entries());
    }

    reset(): void {
        this.metrics.clear();
    }
}

// ==============================
// Validation Plugin
// ==============================

export class ValidationPlugin implements CachePlugin {
    name = "validation";
    version = "1.0.0";
    private validators: Map<RegExp, (value: any) => boolean> = new Map();

    addValidator(pattern: RegExp, validator: (value: any) => boolean): void {
        this.validators.set(pattern, validator);
    }

    beforeSet(key: string, value: any): boolean {
        for (const [pattern, validator] of this.validators.entries()) {
            if (pattern.test(key)) {
                if (!validator(value)) {
                    throw new Error(`Validation failed for key: ${key}`);
                }
            }
        }
        return true;
    }
}

// ==============================
// TTL Refresh Plugin
// ==============================

export class TTLRefreshPlugin implements CachePlugin {
    name = "ttl-refresh";
    version = "1.0.0";
    private refreshOnAccess: boolean;
    private refreshTTL: number;

    constructor(refreshTTL: number, refreshOnAccess = true) {
        this.refreshTTL = refreshTTL;
        this.refreshOnAccess = refreshOnAccess;
    }

    async afterGet(
        key: string,
        value: any,
        entry: CacheEntry | null,
        options?: CacheGetOptions<any>
    ): Promise<void> {
        if (this.refreshOnAccess && entry && entry.expiresAt) {
            // Extend TTL on access
            entry.expiresAt = Date.now() + this.refreshTTL;
        }
    }
}

// ==============================
// Compression Optimizer Plugin
// ==============================

export class CompressionOptimizerPlugin implements CachePlugin {
    name = "compression-optimizer";
    version = "1.0.0";
    private threshold: number;

    constructor(threshold = 10 * 1024) {
        this.threshold = threshold;
    }

    beforeSet(key: string, value: any, options?: CacheSetOptions): CacheSetOptions {
        const size = new Blob([JSON.stringify(value)]).size;
        if (size > this.threshold && !options?.forceCompress) {
            return { ...options, forceCompress: true };
        }
        return options || {};
    }
}

// ==============================
// Tag Manager Plugin
// ==============================

export class TagManagerPlugin implements CachePlugin {
    name = "tag-manager";
    version = "1.0.0";
    private tagIndex: Map<string, Set<string>> = new Map();

    afterSet(key: string, value: any, entry: CacheEntry): void {
        if (entry.tags) {
            for (const tag of entry.tags) {
                if (!this.tagIndex.has(tag)) {
                    this.tagIndex.set(tag, new Set());
                }
                this.tagIndex.get(tag)!.add(key);
            }
        }
    }

    afterDelete(key: string): void {
        // Remove key from all tags
        for (const keys of this.tagIndex.values()) {
            keys.delete(key);
        }
    }

    afterClear(): void {
        this.tagIndex.clear();
    }

    getKeysWithTag(tag: string): string[] {
        return Array.from(this.tagIndex.get(tag) || []);
    }

    getTagsForKey(key: string): string[] {
        const tags: string[] = [];
        for (const [tag, keys] of this.tagIndex.entries()) {
            if (keys.has(key)) {
                tags.push(tag);
            }
        }
        return tags;
    }

    getAllTags(): string[] {
        return Array.from(this.tagIndex.keys());
    }
}

// ==============================
// Rate Limiter Plugin
// ==============================

export class RateLimiterPlugin implements CachePlugin {
    name = "rate-limiter";
    version = "1.0.0";
    private limits: Map<string, { count: number; resetAt: number }> = new Map();
    private maxRequests: number;
    private windowMs: number;

    constructor(maxRequests = 100, windowMs = 60000) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
    }

    beforeSet(key: string): boolean {
        return this.checkLimit(key);
    }

    beforeGet(key: string): boolean {
        return this.checkLimit(key);
    }

    private checkLimit(key: string): boolean {
        const now = Date.now();
        const limit = this.limits.get(key);

        if (!limit || now > limit.resetAt) {
            this.limits.set(key, { count: 1, resetAt: now + this.windowMs });
            return true;
        }

        if (limit.count >= this.maxRequests) {
            throw new Error(`Rate limit exceeded for key: ${key}`);
        }

        limit.count++;
        return true;
    }

    reset(key?: string): void {
        if (key) {
            this.limits.delete(key);
        } else {
            this.limits.clear();
        }
    }
}

// ==============================
// Prefetch Plugin
// ==============================

export class PrefetchPlugin implements CachePlugin {
    name = "prefetch";
    version = "1.0.0";
    private prefetchRules: Map<string, { keys: string[]; loader: () => Promise<any> }> = new Map();

    addPrefetchRule(triggerKey: string, relatedKeys: string[], loader: () => Promise<any>): void {
        this.prefetchRules.set(triggerKey, { keys: relatedKeys, loader });
    }

    async afterGet(key: string): Promise<void> {
        const rule = this.prefetchRules.get(key);
        if (rule) {
            // Trigger prefetch in background
            rule.loader().catch(() => {
                // Silent fail
            });
        }
    }
}

// ==============================
// Warmup Plugin
// ==============================

export class WarmupPlugin implements CachePlugin {
    name = "warmup";
    version = "1.0.0";
    private warmupData: Map<string, { value: any; options?: CacheSetOptions }> = new Map();

    addWarmupData(key: string, value: any, options?: CacheSetOptions): void {
        this.warmupData.set(key, { value, options });
    }

    async warmup(cache: any): Promise<void> {
        for (const [key, data] of this.warmupData.entries()) {
            await cache.set(key, data.value, data.options);
        }
    }
}

// ==============================
// Persistence Plugin (LocalStorage fallback)
// ==============================

export class PersistencePlugin implements CachePlugin {
    name = "persistence";
    version = "1.0.0";
    private storageKey: string;

    constructor(storageKey = "cachecraft-backup") {
        this.storageKey = storageKey;
    }

    async afterSet(key: string, value: any): Promise<void> {
        this.saveToLocalStorage(key, value);
    }

    async afterDelete(key: string): Promise<void> {
        this.removeFromLocalStorage(key);
    }

    private saveToLocalStorage(key: string, value: any): void {
        try {
            const existing = localStorage.getItem(this.storageKey);
            const data = existing ? JSON.parse(existing) : {};
            data[key] = value;
            localStorage.setItem(this.storageKey, JSON.stringify(data));
        } catch (error) {
            // LocalStorage full or disabled
        }
    }

    private removeFromLocalStorage(key: string): void {
        try {
            const existing = localStorage.getItem(this.storageKey);
            if (existing) {
                const data = JSON.parse(existing);
                delete data[key];
                localStorage.setItem(this.storageKey, JSON.stringify(data));
            }
        } catch (error) {
            // Ignore
        }
    }

    loadFromLocalStorage(): Record<string, any> {
        try {
            const existing = localStorage.getItem(this.storageKey);
            return existing ? JSON.parse(existing) : {};
        } catch (error) {
            return {};
        }
    }
}

// ==============================
// Analytics Plugin
// ==============================

export class AnalyticsPlugin implements CachePlugin {
    name = "analytics";
    version = "1.0.0";
    private onEvent?: (event: string, data: any) => void;

    constructor(onEvent?: (event: string, data: any) => void) {
        this.onEvent = onEvent;
    }

    afterSet(key: string, value: any, entry: CacheEntry): void {
        this.track("cache_set", { key, size: entry.size });
    }

    afterGet(key: string, value: any, entry: CacheEntry | null): void {
        this.track("cache_get", { key, hit: !!entry });
    }

    onEvict(keys: string[]): void {
        this.track("cache_evict", { count: keys.length, keys });
    }

    private track(event: string, data: any): void {
        if (this.onEvent) {
            this.onEvent(event, data);
        }
    }
}

// ==============================
// Debug Plugin
// ==============================

export class DebugPlugin implements CachePlugin {
    name = "debug";
    version = "1.0.0";
    private verbose: boolean;

    constructor(verbose = false) {
        this.verbose = verbose;
    }

    beforeSet(key: string, value: any): void {
        if (this.verbose) {
            console.debug("[CACHE DEBUG] Before Set:", { key, value });
        }
    }

    afterSet(key: string, value: any, entry: CacheEntry): void {
        console.debug("[CACHE DEBUG] After Set:", {
            key,
            size: entry.size,
            compressed: entry.isCompressed,
            encrypted: entry.isEncrypted,
        });
    }

    beforeGet(key: string): void {
        if (this.verbose) {
            console.debug("[CACHE DEBUG] Before Get:", { key });
        }
    }

    afterGet(key: string, value: any, entry: CacheEntry | null): void {
        console.debug("[CACHE DEBUG] After Get:", {
            key,
            hit: !!entry,
            accessCount: entry?.accessCount,
        });
    }

    onError(error: Error, operation: string): void {
        console.error("[CACHE DEBUG] Error:", { operation, error: error.message, stack: error.stack });
    }
}
