import type {
    CacheEntry,
    CacheGetOptions,
    CachePlugin,
    CachePluginHost,
    CacheSetOptions,
} from "./types";
import { CacheError, getSize, matchesPattern } from "./utils";

// ==============================
// Logger Plugin
// ==============================

export class LoggerPlugin implements CachePlugin {
    name = "logger";
    version = "1.0.0";
    private logger: (message: string) => void;

    constructor(logger?: (message: string) => void) {
        this.logger = logger ?? ((message) => console.log(message));
    }

    afterSet(key: string, _value: unknown, entry: CacheEntry): void {
        this.logger(`[CACHE] Set: ${key} (${entry.size} bytes)`);
    }

    afterGet(key: string, _value: unknown, entry: CacheEntry | null): void {
        this.logger(entry ? `[CACHE] Hit: ${key}` : `[CACHE] Miss: ${key}`);
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

    afterGet(key: string, _value: unknown, entry: CacheEntry | null): void {
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
        this.metrics.set(metric, (this.metrics.get(metric) ?? 0) + by);
    }

    getMetric(metric: string): number {
        return this.metrics.get(metric) ?? 0;
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

// biome-ignore lint/suspicious/noExplicitAny: validators receive arbitrary cached values; `any` keeps typed callbacks assignable
type Validator = (value: any) => boolean;

export class ValidationPlugin implements CachePlugin {
    name = "validation";
    version = "1.0.0";
    private validators: Map<RegExp, Validator> = new Map();

    addValidator(pattern: RegExp, validator: Validator): void {
        this.validators.set(pattern, validator);
    }

    beforeSet(key: string, value: unknown): boolean {
        for (const [pattern, validator] of this.validators) {
            if (matchesPattern(key, pattern) && !validator(value)) {
                throw new CacheError(`Validation failed for key: ${key}`, "VALIDATION_FAILED");
            }
        }
        return true;
    }
}

// ==============================
// TTL Refresh Plugin (sliding expiration)
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

    afterGet(
        _key: string,
        _value: unknown,
        entry: CacheEntry | null,
        _options?: CacheGetOptions<unknown>
    ): void {
        // The engine applies and persists a changed `entry.expiresAt` (only entries
        // that already have a TTL slide).
        if (this.refreshOnAccess && entry && entry.expiresAt !== undefined) {
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

    beforeSet(_key: string, value: unknown, options?: CacheSetOptions): boolean {
        if (options && !options.forceCompress && getSize(value) > this.threshold) {
            options.forceCompress = true;
        }
        return true;
    }
}

// ==============================
// Tag Manager Plugin
// ==============================

export class TagManagerPlugin implements CachePlugin {
    name = "tag-manager";
    version = "1.0.0";
    private tagIndex: Map<string, Set<string>> = new Map();

    afterSet(key: string, _value: unknown, entry: CacheEntry): void {
        // An overwrite may carry different tags — drop the old associations first.
        this.forget(key);
        for (const tag of entry.tags ?? []) {
            let keys = this.tagIndex.get(tag);
            if (!keys) {
                keys = new Set();
                this.tagIndex.set(tag, keys);
            }
            keys.add(key);
        }
    }

    afterDelete(key: string): void {
        this.forget(key);
    }

    onEvict(keys: string[]): void {
        for (const key of keys) this.forget(key);
    }

    afterClear(): void {
        this.tagIndex.clear();
    }

    private forget(key: string): void {
        for (const [tag, keys] of this.tagIndex) {
            keys.delete(key);
            if (keys.size === 0) this.tagIndex.delete(tag);
        }
    }

    getKeysWithTag(tag: string): string[] {
        return Array.from(this.tagIndex.get(tag) ?? []);
    }

    getTagsForKey(key: string): string[] {
        const tags: string[] = [];
        for (const [tag, keys] of this.tagIndex) {
            if (keys.has(key)) tags.push(tag);
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
            if (this.limits.size >= 1000) this.prune(now);
            this.limits.set(key, { count: 1, resetAt: now + this.windowMs });
            return true;
        }

        if (limit.count >= this.maxRequests) {
            throw new CacheError(`Rate limit exceeded for key: ${key}`, "RATE_LIMITED");
        }

        limit.count++;
        return true;
    }

    /** Drop finished windows so the map cannot grow without bound. */
    private prune(now: number): void {
        for (const [key, limit] of this.limits) {
            if (now > limit.resetAt) this.limits.delete(key);
        }
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

/**
 * A loader may return the related values — as `{ [key]: value }` (only the rule's
 * `relatedKeys` are stored) or as an array aligned with `relatedKeys` — or return nothing
 * and populate the cache itself (the pre-0.5 usage, still supported).
 */
type PrefetchLoader = () => Promise<unknown>;

export class PrefetchPlugin implements CachePlugin {
    name = "prefetch";
    version = "1.0.0";
    private prefetchRules: Map<string, { keys: string[]; loader: PrefetchLoader }> = new Map();
    private running: Set<string> = new Set();
    private host: CachePluginHost | null = null;

    init(host: CachePluginHost): void {
        this.host = host;
    }

    addPrefetchRule(triggerKey: string, relatedKeys: string[], loader: PrefetchLoader): void {
        this.prefetchRules.set(triggerKey, { keys: relatedKeys, loader });
    }

    afterGet(key: string, _value: unknown, entry: CacheEntry | null): void {
        const rule = this.prefetchRules.get(key);
        if (!rule || !entry || !this.host || this.running.has(key)) return;
        void this.prefetch(key, rule, this.host);
    }

    private async prefetch(
        trigger: string,
        rule: { keys: string[]; loader: PrefetchLoader },
        host: CachePluginHost
    ): Promise<void> {
        this.running.add(trigger);
        try {
            // Skip the network when everything is already cached.
            const cached = await Promise.all(rule.keys.map((k) => host.has(k)));
            if (cached.every(Boolean)) return;

            const loaded = await rule.loader();
            if (typeof loaded !== "object" || loaded === null) return;
            // Never store anything outside the rule's own keys: a legacy loader may return
            // an unrelated payload (e.g. a parsed response) that was always discarded.
            const pairs: Array<[string, unknown]> = Array.isArray(loaded)
                ? rule.keys.map((k, i): [string, unknown] => [k, loaded[i]])
                : rule.keys.map((k): [string, unknown] => [
                      k,
                      (loaded as Record<string, unknown>)[k],
                  ]);
            for (const [k, v] of pairs) {
                if (v !== undefined) await host.set(k, v);
            }
        } catch {
            // Prefetching is best-effort and must never surface errors.
        } finally {
            this.running.delete(trigger);
        }
    }
}

// ==============================
// Warmup Plugin
// ==============================

export class WarmupPlugin implements CachePlugin {
    name = "warmup";
    version = "1.0.0";
    private warmupData: Map<string, { value: unknown; options?: CacheSetOptions | undefined }> =
        new Map();

    addWarmupData(key: string, value: unknown, options?: CacheSetOptions): void {
        this.warmupData.set(key, { value, options });
    }

    async warmup(cache: {
        set: (k: string, v: unknown, o?: CacheSetOptions) => Promise<void>;
    }): Promise<void> {
        for (const [key, data] of this.warmupData) {
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

    afterSet(key: string, value: unknown): void {
        this.update((data) => {
            data[key] = value;
        });
    }

    afterDelete(key: string): void {
        this.update((data) => {
            delete data[key];
        });
    }

    onEvict(keys: string[]): void {
        this.update((data) => {
            for (const key of keys) delete data[key];
        });
    }

    afterClear(): void {
        try {
            localStorage.removeItem(this.storageKey);
        } catch {
            // LocalStorage unavailable
        }
    }

    private update(mutate: (data: Record<string, unknown>) => void): void {
        try {
            const data = this.loadFromLocalStorage();
            mutate(data);
            localStorage.setItem(this.storageKey, JSON.stringify(data));
        } catch {
            // LocalStorage full or disabled
        }
    }

    loadFromLocalStorage(): Record<string, unknown> {
        try {
            const existing = localStorage.getItem(this.storageKey);
            return existing ? (JSON.parse(existing) as Record<string, unknown>) : {};
        } catch {
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
    private onEvent: ((event: string, data: Record<string, unknown>) => void) | undefined;

    constructor(onEvent?: (event: string, data: Record<string, unknown>) => void) {
        this.onEvent = onEvent;
    }

    afterSet(key: string, _value: unknown, entry: CacheEntry): void {
        this.track("cache_set", { key, size: entry.size });
    }

    afterGet(key: string, _value: unknown, entry: CacheEntry | null): void {
        this.track("cache_get", { key, hit: !!entry });
    }

    onEvict(keys: string[]): void {
        this.track("cache_evict", { count: keys.length, keys });
    }

    private track(event: string, data: Record<string, unknown>): void {
        this.onEvent?.(event, data);
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

    beforeSet(key: string, value: unknown): boolean {
        if (this.verbose) console.debug("[CACHE DEBUG] Before Set:", { key, value });
        return true;
    }

    afterSet(key: string, _value: unknown, entry: CacheEntry): void {
        console.debug("[CACHE DEBUG] After Set:", {
            key,
            size: entry.size,
            compressed: entry.isCompressed,
            encrypted: entry.isEncrypted,
        });
    }

    beforeGet(key: string): boolean {
        if (this.verbose) console.debug("[CACHE DEBUG] Before Get:", { key });
        return true;
    }

    afterGet(key: string, _value: unknown, entry: CacheEntry | null): void {
        console.debug("[CACHE DEBUG] After Get:", {
            key,
            hit: !!entry,
            accessCount: entry?.accessCount,
        });
    }

    onError(error: Error, operation: string): void {
        console.error("[CACHE DEBUG] Error:", {
            operation,
            error: error.message,
            stack: error.stack,
        });
    }
}
