import { bytesToBase64 } from "./base64";
import {
    type CodecContext,
    convertLegacy,
    decodeRecord,
    decryptPayload,
    type EncodeOptions,
    encodeValue,
    payloadFromExport,
    type ResolvedCompression,
} from "./core/codec";
import { MemoryTier } from "./core/memory-tier";
import { registerEngine, unregisterEngine } from "./core/registry";
import { DEFAULT_KDF_ITERATIONS, decodeSalt, KeyRing, randomSalt } from "./crypto";
import { optionalDuration, parseDuration, parseSize } from "./duration";
import {
    CacheError,
    EncryptionError,
    QuotaExceededError,
    SchemaValidationError,
    TimeoutError,
    toError,
} from "./errors";
import { createEvictionPolicy, rankFor } from "./eviction";
import { acquireLeadership, getLockManager, KeyedMutex, withWebLock } from "./locks";
import { jsonSerializer, richSerializer, serializerRegistry } from "./serializer";
import { acquireStorage } from "./storage";
import { hasIndexedDB } from "./storage/indexeddb";
import type {
    StorageAdapter,
    StoredMeta,
    StoredRecord,
    WriteOp,
    WriteResult,
} from "./storage/types";
import { getAge, getTimeUntilExpiry, isExpired, now as perfNow } from "./time";
import type {
    BatchGetItem,
    BatchResult,
    BatchSetItem,
    CacheConfig,
    CacheEntry,
    CacheEntryMeta,
    CacheEvent,
    CacheEventData,
    CacheEventListener,
    CacheFactory,
    CacheGetOptions,
    CachePlugin,
    CachePluginHost,
    CacheQuery,
    CacheSetOptions,
    CacheStats,
    DetailedStats,
    Duration,
    EngineInfo,
    EntryInfo,
    EvictionPolicy,
    ExportData,
    ExportedEntry,
    ExportOptions,
    GetOrSetOptions,
    HealthStatus,
    ImportOptions,
    LatencySummary,
    LegacyExportData,
    QueryResult,
    RetryOptions,
    Serializer,
    StandardSchemaV1,
    StorageInfo,
    StorageOption,
    SyncMessage,
    SyncMessageType,
    TagQuota,
} from "./types";
import {
    generateId,
    isBroadcastChannelSupported,
    matchesPattern,
    unref,
    utf8ByteLength,
    VERSION,
} from "./utils";

// ==============================
// CacheCraft Engine
//
//  • Storage goes through a StorageAdapter (IndexedDB by default). Records live
//    under [namespace, key]; metadata is stored apart from payloads.
//  • An in-memory metadata index (Map in recency order) answers size/count/keys,
//    eviction, queries and tag lookups without touching storage. It is a *hint*:
//    reads check storage when the index has no entry (read-through) or thinks the
//    entry expired, so other tabs/engines can never make it lie for long.
//  • Optional memory tier (L1) of decoded values in front of storage.
//  • Access-time updates are buffered and merged into storage (`touch`).
//  • getOrSet: single-flight (per realm, optionally across tabs), SWR, retries,
//    timeouts, abort signals.
// ==============================

type Timer = ReturnType<typeof setInterval>;

type ResolvedConfig = {
    dbName: string;
    storeName: string;
    namespace: string;
    label: string;
    maxSize: number;
    maxEntries: number;
    tagQuotas: Array<[string, { maxEntries: number; maxSize: number }]>;
    evictionStrategy: string;
    evictionPolicy: EvictionPolicy | undefined;
    evictionTarget: number;
    defaultTTL: number | undefined;
    ttlJitter: number;
    compression: ResolvedCompression | false;
    schemaVersion: number | undefined;
    migrate: CacheConfig["migrate"];
    memoryCache: { maxEntries: number; maxSize: number; clone: boolean } | null;
    enableStats: boolean;
    enableSync: boolean;
    singleFlightCrossTab: boolean;
    leaderCleanup: boolean;
    readThrough: boolean;
    quotaRecovery: boolean;
    legacy: "migrate" | "ignore";
    onError: (error: Error) => void;
    autoCleanup: boolean;
    cleanupInterval: number;
    persistAccessMetadata: boolean;
    accessMetadataFlushInterval: number;
    devtools: boolean;
};

type Prefetch = { keys: ReadonlySet<string>; records: ReadonlyMap<string, StoredRecord> };

type LookupMode = {
    /** No plugins, stats, events, access updates or deletions. */
    peek?: boolean;
    /** Return expired values (flagged `stale`) instead of a miss. */
    allowStale?: boolean;
    updateAccess?: boolean;
    schema?: StandardSchemaV1<unknown, unknown> | undefined;
    opt?: CacheGetOptions<unknown> | undefined;
    /** Decode as a Blob (`getBlob`). */
    blob?: { type: string | undefined };
    prefetch?: Prefetch;
};

type Lookup =
    | { hit: false }
    | { hit: true; value: unknown; meta: CacheEntryMeta; stale: boolean; fromMemory: boolean };

const MISS: Lookup = { hit: false };

type Flight = {
    promise: Promise<unknown>;
    controller: AbortController;
    waiters: number;
    background: boolean;
};

type PendingAccess = { lastAccessed: number; delta: number; expiresAt?: number | null };

/** @internal Construction details used by `namespace()`. */
export type EngineInternals = {
    /** Plugin instances already initialised by a parent engine. */
    sharedPlugins?: ReadonlySet<CachePlugin>;
};

const LATENCY_WINDOW = 512;

class LatencyWindow {
    private readonly values = new Float64Array(LATENCY_WINDOW);
    private index = 0;
    private filled = 0;
    count = 0;

    record(ms: number): void {
        this.values[this.index] = ms;
        this.index = (this.index + 1) % LATENCY_WINDOW;
        if (this.filled < LATENCY_WINDOW) this.filled++;
        this.count++;
    }

    summary(): LatencySummary {
        const sorted = Array.from(this.values.subarray(0, this.filled)).sort((a, b) => a - b);
        const at = (p: number): number =>
            sorted.length
                ? (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number)
                : 0;
        const sum = sorted.reduce((s, v) => s + v, 0);
        return {
            count: this.count,
            avg: sorted.length ? sum / sorted.length : 0,
            p50: at(0.5),
            p95: at(0.95),
            p99: at(0.99),
            max: sorted.length ? (sorted[sorted.length - 1] as number) : 0,
        };
    }
}

function resolveConfig(cfg: CacheConfig): ResolvedConfig {
    const target = cfg.evictionTarget ?? 0.9;
    const memory = cfg.memoryCache;
    const compression = cfg.compression;
    const threshold =
        (compression ? compression.threshold : undefined) ?? cfg.compressionThreshold ?? 10 * 1024;
    return {
        dbName: cfg.dbName ?? "cache-db",
        storeName: cfg.storeName ?? "cache",
        namespace: cfg.namespace ?? "",
        label: cfg.label ?? "",
        maxSize: parseSize(cfg.maxSize ?? 100 * 1024 * 1024),
        maxEntries: cfg.maxEntries ?? Number.POSITIVE_INFINITY,
        tagQuotas: Object.entries(cfg.tagQuotas ?? {}).map(([tag, q]: [string, TagQuota]) => [
            tag,
            {
                maxEntries: q.maxEntries ?? Number.POSITIVE_INFINITY,
                maxSize: q.maxSize === undefined ? Number.POSITIVE_INFINITY : parseSize(q.maxSize),
            },
        ]),
        evictionStrategy: cfg.evictionStrategy ?? "lru",
        evictionPolicy: cfg.evictionPolicy,
        evictionTarget: Math.min(Math.max(target, 0), 1),
        defaultTTL: optionalDuration(cfg.defaultTTL),
        ttlJitter: Math.min(Math.max(cfg.ttlJitter ?? 0, 0), 1),
        compression:
            compression === false
                ? false
                : {
                      algorithm: (compression ? compression.algorithm : undefined) ?? "gzip",
                      threshold: parseSize(threshold),
                      minRatio: (compression ? compression.minRatio : undefined) ?? 0.9,
                  },
        schemaVersion: cfg.schemaVersion,
        migrate: cfg.migrate,
        memoryCache:
            memory === undefined || memory === false
                ? null
                : {
                      maxEntries: (memory === true ? undefined : memory.maxEntries) ?? 500,
                      maxSize: parseSize(
                          (memory === true ? undefined : memory.maxSize) ?? 10 * 1024 * 1024
                      ),
                      clone: (memory === true ? undefined : memory.clone) ?? false,
                  },
        enableStats: cfg.enableStats ?? true,
        enableSync: cfg.enableSync ?? true,
        singleFlightCrossTab: cfg.crossTab?.singleFlight ?? false,
        leaderCleanup: cfg.crossTab?.leaderCleanup ?? true,
        readThrough: cfg.readThrough ?? true,
        quotaRecovery: cfg.quotaRecovery ?? true,
        legacy: cfg.legacy ?? "migrate",
        onError: cfg.onError ?? (() => undefined),
        autoCleanup: cfg.autoCleanup ?? true,
        cleanupInterval: parseDuration(cfg.cleanupInterval ?? 60_000),
        persistAccessMetadata: cfg.persistAccessMetadata ?? true,
        accessMetadataFlushInterval: parseDuration(cfg.accessMetadataFlushInterval ?? 1_000),
        devtools: cfg.devtools ?? true,
    };
}

function normalizeRetry(retry: number | RetryOptions | undefined): {
    retries: number;
    delay: number;
    factor: number;
    maxDelay: number;
    shouldRetry: RetryOptions["shouldRetry"];
} {
    const options: RetryOptions =
        typeof retry === "number" ? { retries: retry } : (retry ?? { retries: 0 });
    return {
        retries: Math.max(options.retries ?? (retry === undefined ? 0 : 2), 0),
        delay: parseDuration(options.delay ?? 200),
        factor: options.factor ?? 2,
        maxDelay: parseDuration(options.maxDelay ?? 10_000),
        shouldRetry: options.shouldRetry,
    };
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (v) => {
                signal.removeEventListener("abort", onAbort);
                resolve(v);
            },
            (e) => {
                signal.removeEventListener("abort", onAbort);
                reject(e);
            }
        );
    });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return raceAbort(
        new Promise<void>((resolve) => {
            const t = setTimeout(resolve, ms);
            unref(t);
        }),
        signal
    );
}

/** Drop `undefined` properties so every backend stores the same shape. */
function compact<T extends object>(obj: T): T {
    for (const key of Object.keys(obj) as Array<keyof T>) {
        if (obj[key] === undefined) delete obj[key];
    }
    return obj;
}

const SET_OPTION_KEYS = [
    "ttl",
    "ttlJitter",
    "encode",
    "forceCompress",
    "compress",
    "encrypt",
    "tags",
    "metadata",
    "priority",
    "onSet",
] as const;

function pickSetOptions(opt: object | undefined): CacheSetOptions {
    const out: Record<string, unknown> = {};
    if (!opt) return out;
    for (const key of SET_OPTION_KEYS) {
        const value = (opt as Record<string, unknown>)[key];
        if (value !== undefined) out[key] = value;
    }
    return out as CacheSetOptions;
}

export class CacheEngine {
    /** Unique id of this engine instance. */
    readonly id: string;
    private readonly cfg: ResolvedConfig;
    private readonly userConfig: CacheConfig;
    private readonly storage: StorageAdapter;
    private readonly releaseStorage: () => void;
    private readonly storageOption: StorageOption;
    private readonly keyring: KeyRing;
    private readonly codec: CodecContext;
    private readonly policy: EvictionPolicy;
    private readonly startTime: number;

    private plugins: CachePlugin[] = [];
    private readonly pluginFactories: Array<() => CachePlugin>;
    /** Instances produced by factories (re-created, not shared, by `namespace()`). */
    private readonly factoryPlugins = new WeakSet<CachePlugin>();
    private readonly eventListeners = new Map<CacheEvent, Set<CacheEventListener>>();
    private stats: CacheStats;
    private readonly latency = new Map<string, LatencyWindow>();
    private broadcastChannel: BroadcastChannel | null = null;
    private cleanupIntervalId: Timer | null = null;
    private flushIntervalId: Timer | null = null;
    private releaseLeader: (() => void) | null = null;
    private destroyed = false;
    private lastError: Error | undefined;

    // --- in-memory index (Map order = recency, least recent first) ---
    private meta = new Map<string, CacheEntryMeta>();
    private tagIndex = new Map<string, Set<string>>();
    private currentSize = 0;
    private indexReady: Promise<void> | null = null;

    private readonly memory: MemoryTier | null;
    private pendingAccess = new Map<string, PendingAccess>();
    private inflight = new Map<string, Flight>();
    private revalidating = new Set<string>();
    private readonly mutex = new KeyedMutex();

    private readonly onVisibilityChange = (): void => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
            this.flushQuietly();
        }
    };
    private readonly onPageHide = (): void => this.flushQuietly();

    constructor(cfg: CacheConfig = {}, internals: EngineInternals = {}) {
        this.userConfig = { ...cfg };
        this.cfg = resolveConfig(cfg);
        this.id = generateId();
        this.startTime = Date.now();
        this.stats = this.emptyStats();

        this.storageOption = cfg.storage ?? "indexeddb";
        const { adapter, release } = acquireStorage(
            this.storageOption,
            this.cfg.dbName,
            this.cfg.storeName
        );
        this.storage = adapter;
        this.releaseStorage = release;
        const blockedHook = (adapter as { onBlocked?: (fn: () => void) => () => void }).onBlocked;
        blockedHook?.call(adapter, () =>
            this.handleError(
                new CacheError(
                    "Database upgrade is blocked by a connection in another tab (an old version of the app?)",
                    "IDB_BLOCKED"
                ),
                "open"
            )
        );

        const primary = cfg.encryptionKey === "" ? undefined : cfg.encryptionKey;
        this.keyring = new KeyRing(
            primary,
            cfg.decryptionKeys ?? [],
            cfg.kdfIterations ?? DEFAULT_KDF_ITERATIONS,
            () => this.salt()
        );

        const writer: Serializer =
            cfg.serializer === "json"
                ? jsonSerializer
                : cfg.serializer === undefined || cfg.serializer === "rich"
                  ? richSerializer
                  : cfg.serializer;
        this.codec = {
            keyring: this.keyring,
            serializers: serializerRegistry([...(cfg.serializers ?? []), writer]),
            writer,
            compression: this.cfg.compression,
        };

        this.policy =
            this.cfg.evictionStrategy === "custom" && this.cfg.evictionPolicy
                ? this.cfg.evictionPolicy
                : createEvictionPolicy(this.cfg.evictionStrategy);

        const mc = this.cfg.memoryCache;
        this.memory = mc ? new MemoryTier(mc.maxEntries, mc.maxSize, mc.clone) : null;

        this.pluginFactories = [];
        for (const source of cfg.plugins ?? []) {
            if (typeof source === "function") {
                const plugin = source();
                this.pluginFactories.push(source);
                this.factoryPlugins.add(plugin);
                this.use(plugin);
            } else if (internals.sharedPlugins?.has(source)) {
                this.plugins.push(source);
            } else {
                this.use(source);
            }
        }

        if (this.canRunInBackground()) {
            if (this.cfg.enableSync && isBroadcastChannelSupported()) {
                this.broadcastChannel = new BroadcastChannel(`cachecraft:${this.cfg.dbName}`);
                unref(this.broadcastChannel);
                this.broadcastChannel.onmessage = (event) => {
                    void this.handleSyncMessage(event.data as SyncMessage);
                };
            }
            if (this.cfg.autoCleanup) this.startAutoCleanup();
            if (this.cfg.persistAccessMetadata) this.startAccessFlush();
        }

        if (this.cfg.devtools) registerEngine(this);
    }

    /** No timers/channels where the backend can't work (IndexedDB during SSR). */
    private canRunInBackground(): boolean {
        return !(this.storage.kind === "indexeddb" && !hasIndexedDB());
    }

    /** Identity of this engine (used by the devtools). */
    get info(): EngineInfo {
        return {
            id: this.id,
            label:
                this.cfg.label ||
                `${this.cfg.dbName}/${this.cfg.storeName}${this.cfg.namespace ? ` · ${this.cfg.namespace}` : ""}`,
            dbName: this.cfg.dbName,
            storeName: this.cfg.storeName,
            namespace: this.cfg.namespace,
            storage: this.storage.kind,
            persistent: this.storage.persistent,
        };
    }

    /** This engine's namespace (`""` for the root). */
    get namespaceName(): string {
        return this.cfg.namespace;
    }

    private get ns(): string {
        return this.cfg.namespace;
    }

    private assertAlive(): void {
        if (this.destroyed) {
            throw new CacheError("This cache engine has been destroyed", "DESTROYED");
        }
    }

    private async salt(): Promise<Uint8Array> {
        const value = await this.storage.initSystem("kdf-salt", randomSalt);
        if (typeof value !== "string") throw new EncryptionError("Corrupted key-derivation salt");
        return decodeSalt(value);
    }

    // ==============================
    // Index
    // ==============================

    /** Resolves once the in-memory index has been loaded from storage. */
    ready(): Promise<void> {
        return this.ensureIndex();
    }

    /** Re-load the index from storage (e.g. after another app wrote with sync off). */
    async refresh(): Promise<void> {
        this.assertAlive();
        this.indexReady = null;
        this.memory?.clear();
        await this.ensureIndex();
    }

    private ensureIndex(): Promise<void> {
        if (this.destroyed) {
            return Promise.reject(
                new CacheError("This cache engine has been destroyed", "DESTROYED")
            );
        }
        if (!this.indexReady) {
            const pending = this.hydrate();
            this.indexReady = pending;
            pending.catch(() => {
                if (this.indexReady === pending) this.indexReady = null; // allow a retry
            });
        }
        return this.indexReady;
    }

    private async hydrate(): Promise<void> {
        const loaded = await this.storage.loadMeta(this.ns);
        // Insert least-recently-used first: Map order is the recency order.
        loaded.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
        this.resetIndex();
        for (const [key, meta] of loaded) this.indexPut(key, meta);
        this.refreshCountStats();
    }

    private resetIndex(): void {
        this.meta.clear();
        this.tagIndex.clear();
        this.pendingAccess.clear();
        this.currentSize = 0;
    }

    /** Add/replace an entry in the index (moves it to the most-recent end). */
    private indexPut(key: string, stored: StoredMeta): CacheEntryMeta {
        this.indexDrop(key);
        const m: CacheEntryMeta = {
            ...stored,
            key,
            size: Number.isFinite(stored.size) ? stored.size : 0,
            accessCount: stored.accessCount ?? 0,
            isCompressed: stored.isCompressed ?? false,
            isEncrypted: stored.isEncrypted ?? false,
            isEncoded: stored.isEncoded ?? false,
        };
        this.meta.set(key, m);
        this.currentSize += m.size;
        if (m.tags) {
            for (const tag of m.tags) {
                let set = this.tagIndex.get(tag);
                if (!set) {
                    set = new Set();
                    this.tagIndex.set(tag, set);
                }
                set.add(key);
            }
        }
        return m;
    }

    private indexDrop(key: string): boolean {
        const prev = this.meta.get(key);
        if (!prev) return false;
        this.currentSize -= prev.size;
        if (prev.tags) {
            for (const tag of prev.tags) {
                const set = this.tagIndex.get(tag);
                if (set) {
                    set.delete(key);
                    if (set.size === 0) this.tagIndex.delete(tag);
                }
            }
        }
        this.meta.delete(key);
        return true;
    }

    /** Forget a key everywhere in memory (index, pending access, memory tier). */
    private forget(key: string): boolean {
        this.pendingAccess.delete(key);
        this.memory?.delete(key);
        return this.indexDrop(key);
    }

    /** Record a read on the CURRENT index entry (it may have been replaced meanwhile). */
    private markUsed(key: string): void {
        const m = this.meta.get(key);
        if (!m) return;
        const nowMs = Date.now();
        m.lastAccessed = nowMs;
        m.accessCount += 1;
        // Move to the most-recent end.
        this.meta.delete(key);
        this.meta.set(key, m);
        if (this.cfg.persistAccessMetadata) {
            const p = this.pendingAccess.get(key);
            if (p) {
                p.lastAccessed = nowMs;
                p.delta += 1;
            } else {
                this.pendingAccess.set(key, { lastAccessed: nowMs, delta: 1 });
            }
        }
    }

    private validKey(key: unknown): asserts key is string {
        if (typeof key !== "string") {
            throw new CacheError(`Cache keys must be strings (got ${typeof key})`, "INVALID_KEY");
        }
    }

    // ==============================
    // Storage helpers
    // ==============================

    /** Read a record from storage (and from ≤0.5 data, migrating it on the way). */
    private async fetchRecord(
        key: string,
        prefetch?: Prefetch,
        legacy = true
    ): Promise<StoredRecord | undefined> {
        let record: StoredRecord | undefined;
        if (prefetch?.keys.has(key)) {
            record = prefetch.records.get(key);
        } else {
            record = (await this.storage.get(this.ns, [key])).get(key);
        }
        if (record || !legacy) return record;
        return this.migrateLegacyKey(key);
    }

    private async migrateLegacyKey(key: string): Promise<StoredRecord | undefined> {
        if (this.cfg.legacy !== "migrate" || !this.storage.migrateLegacy) return undefined;
        if (!(await this.storage.hasLegacy?.())) return undefined;
        try {
            return await this.storage.migrateLegacy(this.ns, key, convertLegacy);
        } catch (error) {
            this.handleError(toError(error), "migrate");
            return undefined;
        }
    }

    /** Write with quota recovery: on QuotaExceededError evict and retry once. */
    private async persist(ops: WriteOp[], protect: ReadonlySet<string>): Promise<WriteResult> {
        try {
            return await this.storage.write(this.ns, ops);
        } catch (error) {
            if (!(error instanceof QuotaExceededError) || !this.cfg.quotaRecovery) throw error;
            let incoming = 0;
            for (const op of ops) if (op.type === "put") incoming += op.meta.size;
            const freed = await this.evictBytes(
                Math.max(incoming * 2, this.currentSize * 0.2),
                protect
            );
            if (freed === 0) throw error;
            return this.storage.write(this.ns, ops);
        }
    }

    private resolveTTL(ttl: Duration | undefined, jitter: number | undefined): number | undefined {
        let ms = optionalDuration(ttl ?? this.cfg.defaultTTL);
        const j = Math.min(Math.max(jitter ?? this.cfg.ttlJitter, 0), 1);
        if (ms !== undefined && j > 0) ms = Math.floor(ms - Math.random() * j * ms);
        return ms;
    }

    private async buildRecord(
        value: unknown,
        opt: CacheSetOptions
    ): Promise<{ record: StoredRecord; rawSize: number }> {
        const encoded = await encodeValue(this.codec, value, opt as EncodeOptions);
        const nowMs = Date.now();
        const ttl = this.resolveTTL(opt.ttl, opt.ttlJitter);
        const tags = opt.tags?.length ? [...new Set(opt.tags)] : undefined;
        const meta: StoredMeta = compact({
            ...encoded.meta,
            createdAt: nowMs,
            lastAccessed: nowMs,
            accessCount: 0,
            expiresAt: ttl === undefined ? undefined : nowMs + ttl,
            ttl,
            priority: opt.priority,
            tags,
            metadata: opt.metadata,
            schemaVersion: this.cfg.schemaVersion,
            kind: "value" as const,
        });
        return { record: { meta, payload: encoded.payload }, rawSize: encoded.rawSize };
    }

    private entryView(meta: CacheEntryMeta | StoredMeta, value: unknown): CacheEntry {
        const { key: _key, ...rest } = meta as CacheEntryMeta;
        return { ...rest, value: value as CacheEntry["value"] };
    }

    // ==============================
    // Writes
    // ==============================

    async set<T>(key: string, value: T, opt?: CacheSetOptions): Promise<void> {
        const started = perfNow();
        let ok = false;
        try {
            this.validKey(key);
            await this.ensureIndex();
            // Plugins may adjust the options (e.g. forceCompress) — work on a copy.
            const options: CacheSetOptions = { ...opt };
            if (!(await this.runBeforeSet(key, value, options))) return;
            const { record, rawSize } = await this.buildRecord(value, options);
            await this.commit(key, value, record, options, rawSize);
            ok = true;
        } catch (error) {
            this.handleError(toError(error), "set");
            throw error;
        } finally {
            this.track("set", started, ok);
        }
    }

    private async runBeforeSet(
        key: string,
        value: unknown,
        options: CacheSetOptions
    ): Promise<boolean> {
        for (const plugin of this.plugins) {
            if (plugin.beforeSet && (await plugin.beforeSet(key, value, options)) === false) {
                return false;
            }
        }
        return true;
    }

    /** Persist one prepared record and run the bookkeeping shared by set/setBlob/update. */
    private async commit(
        key: string,
        value: unknown,
        record: StoredRecord,
        options: CacheSetOptions,
        rawSize: number | undefined
    ): Promise<void> {
        await this.persist(
            [{ type: "put", key, meta: record.meta, payload: record.payload }],
            new Set([key])
        );
        this.pendingAccess.delete(key);
        const m = this.indexPut(key, record.meta);
        if (this.memory) {
            if (rawSize !== undefined) this.memory.set(key, value, rawSize, m.expiresAt);
            else this.memory.delete(key);
        }
        await this.enforceBudgets().catch((err) => this.handleError(toError(err), "evict"));

        if (this.cfg.enableStats) {
            this.stats.sets++;
            this.refreshCountStats();
        }
        for (const plugin of this.plugins) {
            if (plugin.afterSet)
                await plugin.afterSet(key, value, this.entryView(m, record.payload), options);
        }
        this.emit("set", { event: "set", key, value, timestamp: Date.now() });
        options.onSet?.(key, value);
        this.broadcast("set", [key]);
    }

    async remove(key: string): Promise<boolean> {
        const started = perfNow();
        let ok = false;
        try {
            this.validKey(key);
            await this.ensureIndex();
            const deleted = await this.deleteKeys([key], true);
            ok = true;
            return deleted.includes(key);
        } catch (error) {
            this.handleError(toError(error), "remove");
            throw error;
        } finally {
            this.track("remove", started, ok);
        }
    }

    /** Alias of {@link remove}. */
    delete(key: string): Promise<boolean> {
        return this.remove(key);
    }

    /**
     * Delete keys in ONE transaction. With `vetoable`, plugins' `beforeDelete` may
     * keep keys. Returns the keys that actually existed and were removed.
     */
    private async deleteKeys(keys: readonly string[], vetoable: boolean): Promise<string[]> {
        let targets = [...new Set(keys)];
        if (vetoable && this.plugins.some((p) => p.beforeDelete)) {
            const allowed: string[] = [];
            for (const key of targets) {
                let proceed = true;
                for (const plugin of this.plugins) {
                    if (plugin.beforeDelete && (await plugin.beforeDelete(key)) === false) {
                        proceed = false;
                        break;
                    }
                }
                if (proceed) allowed.push(key);
            }
            targets = allowed;
        }
        if (targets.length === 0) return [];

        const result = await this.storage.write(
            this.ns,
            targets.map((key) => ({ type: "delete", key }))
        );
        const removed = new Set(result.deleted);
        for (const key of targets) {
            if (this.forget(key)) removed.add(key);
        }
        const deleted = targets.filter((k) => removed.has(k));
        if (this.cfg.enableStats) {
            this.stats.deletes += deleted.length;
            this.refreshCountStats();
        }
        for (const key of targets) {
            const existed = removed.has(key);
            for (const plugin of this.plugins) {
                if (plugin.afterDelete) await plugin.afterDelete(key, existed);
            }
            this.emit("delete", { event: "delete", key, timestamp: Date.now() });
        }
        this.broadcast("delete", targets);
        return deleted;
    }

    /** Remove every entry of this engine's namespace (other namespaces are untouched). */
    async clear(): Promise<number> {
        try {
            await this.ensureIndex();
            for (const plugin of this.plugins) {
                if (plugin.beforeClear && (await plugin.beforeClear()) === false) return 0;
            }
            const count = this.meta.size;
            await this.storage.clear(this.ns);
            this.resetIndex();
            this.memory?.clear();
            this.refreshCountStats();
            for (const plugin of this.plugins) {
                if (plugin.afterClear) await plugin.afterClear(count);
            }
            this.emit("clear", { event: "clear", timestamp: Date.now(), metadata: { count } });
            this.broadcast("clear");
            return count;
        } catch (error) {
            this.handleError(toError(error), "clear");
            throw error;
        }
    }

    /**
     * A sibling engine on the same database/store, scoped to another namespace.
     * Plugin *factories* are invoked again; plugin *instances* are shared as-is
     * (they stay bound to the engine that created them).
     */
    namespace(ns: string, overrides: Omit<CacheConfig, "namespace"> = {}): CacheEngine {
        const storage =
            typeof this.storageOption === "function" ? this.storage : this.storageOption;
        // Factories run again for the child; instances (incl. `use()`d ones) are shared.
        const instances = this.plugins.filter((p) => !this.factoryPlugins.has(p));
        return new CacheEngine(
            {
                ...this.userConfig,
                storage,
                ...overrides,
                namespace: ns,
                plugins: overrides.plugins ?? [...this.pluginFactories, ...instances],
            },
            { sharedPlugins: new Set(instances) }
        );
    }

    // ==============================
    // Reads
    // ==============================

    async get<T>(key: string, opt?: CacheGetOptions<T>): Promise<T | null> {
        const started = perfNow();
        let ok = false;
        try {
            this.validKey(key);
            const result = await this.lookup(key, {
                allowStale: opt?.staleWhileRevalidate === true,
                updateAccess: opt?.updateAccessTime ?? true,
                schema: opt?.schema as StandardSchemaV1<unknown, unknown> | undefined,
                opt: opt as CacheGetOptions<unknown> | undefined,
            });
            ok = true;
            if (!result.hit) return null;
            if (result.stale && opt?.revalidate) {
                this.revalidateInBackground(key, result.meta, opt as CacheGetOptions<unknown>);
            }
            return result.value as T;
        } catch (error) {
            this.handleError(toError(error), "get");
            throw error;
        } finally {
            this.track("get", started, ok);
        }
    }

    /**
     * Read without side effects: no plugins, stats, events or access-time update,
     * and expired entries are not deleted. `null` when missing (or expired, unless
     * `allowStale`).
     */
    async peek<T>(key: string, options?: { allowStale?: boolean }): Promise<T | null> {
        this.validKey(key);
        const result = await this.lookup(key, {
            peek: true,
            allowStale: options?.allowStale ?? false,
        });
        return result.hit ? (result.value as T) : null;
    }

    /** The value together with its metadata (age, remaining TTL, tags…). */
    async getWithMeta<T>(
        key: string,
        options?: CacheGetOptions<T> & { allowStale?: boolean }
    ): Promise<{ value: T; info: EntryInfo } | null> {
        this.validKey(key);
        const result = await this.lookup(key, {
            allowStale: options?.allowStale ?? options?.staleWhileRevalidate ?? false,
            updateAccess: options?.updateAccessTime ?? true,
            schema: options?.schema as StandardSchemaV1<unknown, unknown> | undefined,
            opt: options as CacheGetOptions<unknown> | undefined,
        });
        if (!result.hit) return null;
        return { value: result.value as T, info: this.infoOf(result.meta) };
    }

    private infoOf(m: CacheEntryMeta): EntryInfo {
        const nowMs = Date.now();
        return {
            key: m.key,
            createdAt: m.createdAt,
            lastAccessed: m.lastAccessed,
            accessCount: m.accessCount,
            expiresAt: m.expiresAt,
            age: getAge(m.createdAt, nowMs),
            ttlRemaining: getTimeUntilExpiry(m.expiresAt, nowMs),
            stale: isExpired(m.expiresAt, nowMs),
            size: m.size,
            tags: m.tags ?? [],
            metadata: m.metadata,
            priority: m.priority,
            isCompressed: m.isCompressed,
            isEncrypted: m.isEncrypted,
        };
    }

    /** The shared read path. */
    private async lookup(key: string, mode: LookupMode): Promise<Lookup> {
        const started = perfNow();
        await this.ensureIndex();
        const peek = mode.peek === true;
        const opt = mode.opt;

        if (!peek) {
            for (const plugin of this.plugins) {
                if (plugin.beforeGet && (await plugin.beforeGet(key, opt)) === false) {
                    return this.recordMiss(key, mode);
                }
            }
        }

        const nowMs = Date.now();
        let m = this.meta.get(key);

        // Memory tier.
        if (this.memory && !mode.blob && m && !isExpired(m.expiresAt, nowMs)) {
            const cached = this.memory.get(key, nowMs);
            if (cached) {
                const validated = await this.validate(key, cached.value, mode.schema);
                if (!validated.ok) {
                    if (!peek) await this.deleteKeys([key], false).catch(() => undefined);
                    return this.recordMiss(key, mode);
                }
                return this.recordHit(
                    key,
                    m,
                    validated.value,
                    cached.value,
                    false,
                    true,
                    mode,
                    started
                );
            }
        }

        let record: StoredRecord | undefined;
        if (!m) {
            // Not in our index — another tab/engine may have written it (read-through),
            // or it may still sit in ≤0.5 data (migrated on the fly).
            if (!this.cfg.readThrough && this.cfg.legacy !== "migrate")
                return this.recordMiss(key, mode);
            record = this.cfg.readThrough
                ? await this.fetchRecord(key, mode.prefetch)
                : await this.migrateLegacyKey(key);
            if (!record) return this.recordMiss(key, mode);
            m = this.indexPut(key, record.meta);
        }

        let stale = false;
        if (isExpired(m.expiresAt, nowMs)) {
            // The index may be stale: another tab could have refreshed the entry.
            record ??= await this.fetchRecord(key, mode.prefetch, false);
            if (!record) {
                this.forget(key);
                return this.recordMiss(key, mode);
            }
            m = this.indexPut(key, record.meta);
            if (isExpired(m.expiresAt, nowMs)) {
                if (!mode.allowStale) {
                    if (!peek) await this.expireKeys([key]);
                    return this.recordMiss(key, mode);
                }
                stale = true;
            }
        }

        record ??= await this.fetchRecord(key, mode.prefetch, false);
        if (!record) {
            // Index/storage drift (deleted elsewhere) — heal and report a miss.
            this.forget(key);
            return this.recordMiss(key, mode);
        }

        let value: unknown;
        if (mode.blob) {
            if (
                record.meta.kind !== "blob" &&
                !(
                    record.payload instanceof Uint8Array &&
                    !record.meta.isCompressed &&
                    record.meta.serializer === "json"
                )
            ) {
                return this.recordMiss(key, mode);
            }
            const bytes = (await decryptPayload(this.codec, record)) as Uint8Array;
            value = new Blob([bytes as Uint8Array<ArrayBuffer>], {
                type: mode.blob.type ?? record.meta.mimeType ?? "application/octet-stream",
            });
        } else {
            const decoded = await this.decodeValue(key, record);
            if (!decoded.ok) {
                if (!peek) await this.deleteKeys([key], false).catch(() => undefined);
                return this.recordMiss(key, mode);
            }
            const validated = await this.validate(key, decoded.value, mode.schema);
            if (!validated.ok) {
                if (!peek) await this.deleteKeys([key], false).catch(() => undefined);
                return this.recordMiss(key, mode);
            }
            value = validated.value;
            // A schema migration may have rewritten the entry: use the current metadata.
            m = this.meta.get(key) ?? m;
            if (this.memory && !stale) {
                this.memory.set(key, decoded.value, m.originalSize ?? m.size, m.expiresAt);
            }
        }
        return this.recordHit(key, m, value, record.payload, stale, false, mode, started);
    }

    private async decodeValue(
        key: string,
        record: StoredRecord
    ): Promise<{ ok: true; value: unknown } | { ok: false }> {
        if (record.meta.kind === "blob") {
            return { ok: true, value: await decryptPayload(this.codec, record) };
        }
        let value = await decodeRecord(this.codec, record);
        const want = this.cfg.schemaVersion;
        const have = record.meta.schemaVersion ?? 0;
        if (want !== undefined && have !== want) {
            if (!this.cfg.migrate) return { ok: false };
            value = await this.cfg.migrate(value, have, key);
            if (value === undefined) return { ok: false };
            await this.rewrite(key, value, record.meta).catch((err) =>
                this.handleError(toError(err), "migrate")
            );
        }
        return { ok: true, value };
    }

    /** Re-encode a value in place, keeping its lifetime and metadata. */
    private async rewrite(key: string, value: unknown, previous: StoredMeta): Promise<void> {
        const encoded = await encodeValue(this.codec, value, {
            encrypt: previous.isEncrypted,
            encode: previous.isEncoded,
        });
        const meta: StoredMeta = compact({
            ...previous,
            ...encoded.meta,
            schemaVersion: this.cfg.schemaVersion,
        });
        await this.persist([{ type: "put", key, meta, payload: encoded.payload }], new Set([key]));
        this.indexPut(key, meta);
        this.broadcast("set", [key]);
    }

    private async validate(
        key: string,
        value: unknown,
        schema: StandardSchemaV1<unknown, unknown> | undefined
    ): Promise<{ ok: true; value: unknown } | { ok: false }> {
        if (!schema) return { ok: true, value };
        const result = await schema["~standard"].validate(value);
        if (result.issues) {
            this.handleError(
                new SchemaValidationError(
                    `Cached value for "${key}" failed schema validation: ${result.issues
                        .map((i) => i.message)
                        .join("; ")}`,
                    result.issues
                ),
                "validate"
            );
            return { ok: false };
        }
        return { ok: true, value: result.value };
    }

    private async recordHit(
        key: string,
        meta: CacheEntryMeta,
        value: unknown,
        payload: unknown,
        stale: boolean,
        fromMemory: boolean,
        mode: LookupMode,
        started: number
    ): Promise<Lookup> {
        let m = meta;
        if (mode.peek) return { hit: true, value, meta: m, stale, fromMemory };
        if (mode.updateAccess ?? true) this.markUsed(key);
        m = this.meta.get(key) ?? m;
        if (this.cfg.enableStats) {
            this.stats.hits++;
            if (fromMemory) this.stats.memoryHits++;
            this.stats.avgAccessTime +=
                (perfNow() - started - this.stats.avgAccessTime) / this.stats.hits;
            this.recomputeRates();
        }
        this.emit("hit", { event: "hit", key, value, timestamp: Date.now() });
        this.emit("get", { event: "get", key, value, timestamp: Date.now() });
        if (this.plugins.some((p) => p.afterGet)) {
            const entry = this.entryView(m, payload);
            for (const plugin of this.plugins) {
                if (plugin.afterGet) await plugin.afterGet(key, value, entry, mode.opt);
            }
            this.applyPluginExpiry(key, m, entry);
        }
        mode.opt?.onGet?.(key, value);
        return { hit: true, value, meta: m, stale, fromMemory };
    }

    private async recordMiss(key: string, mode: LookupMode): Promise<Lookup> {
        if (mode.peek) return MISS;
        if (this.cfg.enableStats) {
            this.stats.misses++;
            this.recomputeRates();
        }
        this.emit("miss", { event: "miss", key, timestamp: Date.now() });
        for (const plugin of this.plugins) {
            if (plugin.afterGet) await plugin.afterGet(key, null, null, mode.opt);
        }
        mode.opt?.onGet?.(key, null);
        return MISS;
    }

    /** A plugin (e.g. TTLRefreshPlugin) may have changed `entry.expiresAt` in afterGet. */
    private applyPluginExpiry(key: string, m: CacheEntryMeta, entry: CacheEntry): void {
        if (entry.expiresAt === m.expiresAt || this.meta.get(key) !== m) return;
        m.expiresAt = entry.expiresAt;
        this.memory?.setExpiry(key, m.expiresAt);
        const p = this.pendingAccess.get(key) ?? { lastAccessed: m.lastAccessed, delta: 0 };
        p.expiresAt = m.expiresAt ?? null;
        this.pendingAccess.set(key, p);
        if (!this.cfg.persistAccessMetadata) this.flushQuietly();
    }

    /** Delete keys only if they are still expired in storage. */
    private async expireKeys(keys: readonly string[]): Promise<string[]> {
        const nowMs = Date.now();
        const result = await this.storage.write(
            this.ns,
            keys.map((key) => ({ type: "deleteIfExpired", key, now: nowMs }))
        );
        const deleted = new Set(result.deleted);
        const survivors: string[] = [];
        for (const key of keys) {
            if (deleted.has(key)) {
                this.forget(key);
                this.emit("expire", { event: "expire", key, timestamp: Date.now() });
            } else {
                survivors.push(key);
            }
        }
        if (survivors.length) {
            // Refreshed elsewhere (or already gone): resync the index.
            const metas = await this.storage.getMeta(this.ns, survivors);
            for (const key of survivors) {
                const stored = metas.get(key);
                if (stored) this.indexPut(key, stored);
                else this.forget(key);
            }
        }
        if (deleted.size) {
            this.refreshCountStats();
            this.broadcast("delete", [...deleted]);
        }
        return [...deleted];
    }

    private revalidateInBackground(
        key: string,
        meta: CacheEntryMeta,
        opt: CacheGetOptions<unknown>
    ): void {
        const revalidate = opt.revalidate;
        if (!revalidate || this.revalidating.has(key)) return;
        this.revalidating.add(key);
        void (async () => {
            try {
                let fresh: unknown;
                try {
                    fresh = await revalidate();
                } catch (err) {
                    this.handleError(toError(err), "revalidate");
                    return;
                }
                await this.set(key, fresh, {
                    ttl: opt.ttlOnRevalidate ?? meta.ttl,
                    tags: meta.tags,
                    metadata: meta.metadata,
                    priority: meta.priority,
                    encrypt: meta.isEncrypted,
                }).catch(() => undefined);
            } finally {
                this.revalidating.delete(key);
            }
        })();
    }

    // ==============================
    // getOrSet
    // ==============================

    /**
     * Cache-aside: the cached value, or the factory's result (which is stored).
     * Concurrent calls share one factory run (single-flight). A cached `null`
     * counts as a hit.
     */
    async getOrSet<T>(key: string, factory: CacheFactory<T>, opt?: GetOrSetOptions<T>): Promise<T> {
        const started = perfNow();
        let ok = false;
        try {
            this.validKey(key);
            await this.ensureIndex();
            const value = await this.getOrSetInner(key, factory, opt);
            ok = true;
            return value;
        } finally {
            this.track("getOrSet", started, ok);
        }
    }

    private withinMaxStale(m: CacheEntryMeta, maxStale: number | undefined): boolean {
        if (maxStale === undefined || m.expiresAt === undefined) return true;
        return Date.now() - m.expiresAt <= maxStale;
    }

    private async getOrSetInner<T>(
        key: string,
        factory: CacheFactory<T>,
        opt: GetOrSetOptions<T> | undefined
    ): Promise<T> {
        const maxStale = optionalDuration(opt?.maxStale);
        const schema = opt?.schema as StandardSchemaV1<unknown, unknown> | undefined;
        const wantsStale = opt?.staleWhileRevalidate === true || opt?.fallbackToStale === true;

        let stale: { value: T; meta: CacheEntryMeta } | undefined;
        if (!opt?.forceRefresh) {
            const found = await this.lookup(key, { allowStale: wantsStale, schema });
            if (found.hit && !found.stale) return found.value as T;
            if (found.hit && found.stale && this.withinMaxStale(found.meta, maxStale)) {
                stale = { value: found.value as T, meta: found.meta };
            }
        } else if (opt?.fallbackToStale) {
            const found = await this.lookup(key, { peek: true, allowStale: true, schema });
            if (found.hit && this.withinMaxStale(found.meta, maxStale)) {
                stale = { value: found.value as T, meta: found.meta };
            }
        }

        if (opt?.signal?.aborted) throw abortReason(opt.signal);
        if (stale && opt?.staleWhileRevalidate) {
            this.flight(key, factory, opt, stale.value, true).catch((err) =>
                this.handleError(toError(err), "revalidate")
            );
            return stale.value;
        }

        try {
            return await this.flight(key, factory, opt, stale?.value, false);
        } catch (error) {
            if (opt?.fallbackToStale && stale) return stale.value;
            throw error;
        }
    }

    /** Join the in-progress factory run for this key, or start one. */
    private flight<T>(
        key: string,
        factory: CacheFactory<T>,
        opt: GetOrSetOptions<T> | undefined,
        stale: T | undefined,
        background: boolean
    ): Promise<T> {
        let flight = this.inflight.get(key);
        if (!flight) {
            const controller = new AbortController();
            const created: Flight = {
                promise: Promise.resolve(),
                controller,
                waiters: 0,
                background,
            };
            created.promise = this.runFlight(
                key,
                factory,
                opt,
                stale,
                background,
                controller
            ).finally(() => {
                if (this.inflight.get(key) === created) this.inflight.delete(key);
            });
            // Rejections are delivered to waiters; don't leave the shared promise unhandled.
            created.promise.catch(() => undefined);
            this.inflight.set(key, created);
            flight = created;
        } else if (!background) {
            flight.background = false;
        }
        if (background) return flight.promise as Promise<T>;
        return this.waitFor(flight, opt?.signal) as Promise<T>;
    }

    private waitFor(flight: Flight, signal: AbortSignal | undefined): Promise<unknown> {
        flight.waiters++;
        const leave = (): void => {
            flight.waiters--;
        };
        if (!signal) return flight.promise.finally(leave);
        return raceAbort(flight.promise, signal).then(
            (value) => {
                leave();
                return value;
            },
            (error) => {
                leave();
                // Last interested caller gave up: abort the factory too.
                if (signal.aborted && flight.waiters <= 0 && !flight.background) {
                    flight.controller.abort(abortReason(signal));
                }
                throw error;
            }
        );
    }

    private async runFlight<T>(
        key: string,
        factory: CacheFactory<T>,
        opt: GetOrSetOptions<T> | undefined,
        stale: T | undefined,
        refresh: boolean,
        controller: AbortController
    ): Promise<T> {
        const crossTab = opt?.crossTab ?? this.cfg.singleFlightCrossTab;
        if (crossTab && getLockManager()) {
            return withWebLock(
                `cachecraft:${this.cfg.dbName}:${this.cfg.storeName}:${this.ns}:${key}`,
                async () => {
                    // Another tab may have produced the value while we waited for the lock.
                    if (!opt?.forceRefresh) {
                        const fresh = await this.lookup(key, {
                            schema: opt?.schema as StandardSchemaV1<unknown, unknown> | undefined,
                        });
                        if (fresh.hit && !fresh.stale) return fresh.value as T;
                    }
                    return this.runFactory(key, factory, opt, stale, refresh, controller);
                },
                { signal: controller.signal }
            );
        }
        return this.runFactory(key, factory, opt, stale, refresh, controller);
    }

    private async runFactory<T>(
        key: string,
        factory: CacheFactory<T>,
        opt: GetOrSetOptions<T> | undefined,
        stale: T | undefined,
        refresh: boolean,
        controller: AbortController
    ): Promise<T> {
        const signal = controller.signal;
        const retry = normalizeRetry(opt?.retry);
        const timeout = optionalDuration(opt?.timeout);
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (timeout !== undefined) {
            timer = setTimeout(
                () =>
                    controller.abort(
                        new TimeoutError(`getOrSet("${key}") timed out after ${timeout}ms`)
                    ),
                timeout
            );
            unref(timer);
        }
        try {
            let delay = retry.delay;
            for (let attempt = 1; ; attempt++) {
                if (signal.aborted) throw abortReason(signal);
                try {
                    const value = await raceAbort(
                        Promise.resolve().then(() => factory({ key, signal, attempt, stale })),
                        signal
                    );
                    const setOptions = pickSetOptions(opt);
                    if (refresh && opt?.ttlOnRevalidate !== undefined)
                        setOptions.ttl = opt.ttlOnRevalidate;
                    // A caching failure (quota, validation…) is reported via onError but
                    // must not lose a value we already computed.
                    await this.set(key, value, setOptions).catch(() => undefined);
                    return value;
                } catch (error) {
                    if (signal.aborted) throw abortReason(signal);
                    if (attempt > retry.retries) throw error;
                    if (retry.shouldRetry && !retry.shouldRetry(error, attempt)) throw error;
                    await sleep(delay, signal);
                    delay = Math.min(delay * retry.factor, retry.maxDelay);
                }
            }
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    // ==============================
    // Entry helpers
    // ==============================

    async has(key: string): Promise<boolean> {
        this.validKey(key);
        await this.ensureIndex();
        let m = this.meta.get(key);
        if (!m && this.cfg.readThrough) m = await this.reloadKey(key);
        if (!m) {
            const legacy = await this.migrateLegacyKey(key);
            if (legacy) m = this.indexPut(key, legacy.meta);
        }
        if (!m) return false;
        if (!isExpired(m.expiresAt)) return true;
        // Expired in our index: delete it, unless another tab refreshed it meanwhile.
        await this.expireKeys([key]);
        const after = this.meta.get(key);
        return after !== undefined && !isExpired(after.expiresAt);
    }

    private async reloadKey(key: string): Promise<CacheEntryMeta | undefined> {
        const stored = (await this.storage.getMeta(this.ns, [key])).get(key);
        return stored ? this.indexPut(key, stored) : undefined;
    }

    /**
     * Extend an entry's life without rewriting it. `ttl` defaults to the TTL it
     * was written with; `null` removes the expiry. Returns false when missing.
     */
    async touch(key: string, ttl?: Duration | null): Promise<boolean> {
        this.validKey(key);
        await this.ensureIndex();
        const m =
            this.meta.get(key) ?? (this.cfg.readThrough ? await this.reloadKey(key) : undefined);
        if (!m) return false;
        const nowMs = Date.now();
        let expiresAt: number | null;
        let ttlMs: number | undefined;
        if (ttl === null) {
            expiresAt = null;
        } else {
            ttlMs = ttl === undefined ? m.ttl : parseDuration(ttl);
            expiresAt = ttlMs === undefined ? (m.expiresAt ?? null) : nowMs + ttlMs;
        }
        await this.storage.write(this.ns, [{ type: "touch", key, lastAccessed: nowMs, expiresAt }]);
        m.expiresAt = expiresAt ?? undefined;
        if (ttlMs !== undefined) m.ttl = ttlMs;
        m.lastAccessed = nowMs;
        this.memory?.setExpiry(key, m.expiresAt);
        this.broadcast("set", [key]);
        return true;
    }

    /**
     * Read-modify-write. `fn` receives the current value (`null` when missing) and
     * returns the next one (`undefined` deletes). Serialised per key in this tab and,
     * with `crossTab`, across tabs. Without `options`, the entry keeps its remaining
     * TTL, tags, priority, metadata and encryption.
     */
    async update<T>(
        key: string,
        fn: (current: T | null) => T | undefined | Promise<T | undefined>,
        options?: CacheSetOptions & { crossTab?: boolean }
    ): Promise<T | undefined> {
        this.validKey(key);
        const run = async (): Promise<T | undefined> => {
            const current = await this.getWithMeta<T>(key);
            const next = await fn(current ? current.value : null);
            if (next === undefined) {
                await this.remove(key);
                return undefined;
            }
            let setOptions: CacheSetOptions | undefined = options
                ? pickSetOptions(options)
                : undefined;
            if (!setOptions && current) {
                const m = this.meta.get(key);
                setOptions = compact({
                    ttl: current.info.ttlRemaining ?? undefined,
                    tags: current.info.tags.length ? current.info.tags : undefined,
                    priority: current.info.priority,
                    metadata: current.info.metadata,
                    encrypt: current.info.isEncrypted || undefined,
                    encode: m?.isEncoded || undefined,
                });
            }
            await this.set(key, next, setOptions);
            return next;
        };
        const crossTab = options?.crossTab ?? this.cfg.singleFlightCrossTab;
        return this.mutex.run(key, () =>
            crossTab
                ? withWebLock(
                      `cachecraft-update:${this.cfg.dbName}:${this.cfg.storeName}:${this.ns}:${key}`,
                      run
                  )
                : run()
        );
    }

    /** Total stored bytes of this namespace (O(1)). */
    async size(): Promise<number> {
        await this.ensureIndex();
        return this.currentSize;
    }

    /** Entry count of this namespace (O(1)). */
    async count(): Promise<number> {
        await this.ensureIndex();
        return this.meta.size;
    }

    async keys(pattern?: RegExp | string): Promise<string[]> {
        await this.ensureIndex();
        const ks = Array.from(this.meta.keys());
        return pattern ? ks.filter((k) => matchesPattern(k, pattern)) : ks;
    }

    // ==============================
    // Tags & patterns
    // ==============================

    async keysByTag(tag: string): Promise<string[]> {
        await this.ensureIndex();
        return Array.from(this.tagIndex.get(tag) ?? []);
    }

    /** Delete every entry carrying `tag` (one transaction). Returns the count removed. */
    async invalidateByTag(tag: string): Promise<number> {
        return this.invalidateByTags([tag]);
    }

    /** Delete entries carrying ANY of the tags (one transaction). */
    async invalidateByTags(tags: readonly string[]): Promise<number> {
        await this.ensureIndex();
        const keys = new Set<string>();
        for (const tag of tags) for (const key of this.tagIndex.get(tag) ?? []) keys.add(key);
        if (keys.size === 0) return 0;
        return (await this.deleteKeys([...keys], true)).length;
    }

    /** Delete every key matching a RegExp or containing a substring. */
    async invalidateByPattern(pattern: RegExp | string): Promise<number> {
        const keys = await this.keys(pattern);
        if (keys.length === 0) return 0;
        return (await this.deleteKeys(keys, true)).length;
    }

    /**
     * All known tags. Synchronous, so it reflects the index as loaded so far —
     * `await cache.ready()` first if no other operation has run yet.
     */
    allTags(): string[] {
        return Array.from(this.tagIndex.keys());
    }

    // ==============================
    // Blobs
    // ==============================

    async setBlob(key: string, blob: Blob, opt?: CacheSetOptions): Promise<void> {
        const started = perfNow();
        let ok = false;
        try {
            this.validKey(key);
            await this.ensureIndex();
            const options: CacheSetOptions = { ...opt };
            if (!(await this.runBeforeSet(key, blob, options))) return;
            let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
            let keyId: string | undefined;
            if (options.encrypt) {
                const result = await this.keyring.encrypt(bytes);
                bytes = result.data;
                keyId = result.keyId;
            }
            const nowMs = Date.now();
            const ttl = this.resolveTTL(options.ttl, options.ttlJitter);
            const meta: StoredMeta = compact({
                size: bytes.byteLength,
                createdAt: nowMs,
                lastAccessed: nowMs,
                accessCount: 0,
                expiresAt: ttl === undefined ? undefined : nowMs + ttl,
                ttl,
                priority: options.priority,
                tags: options.tags?.length ? [...new Set(options.tags)] : undefined,
                metadata: options.metadata,
                isCompressed: false,
                isEncrypted: options.encrypt === true,
                isEncoded: false,
                keyId,
                kind: "blob" as const,
                mimeType: blob.type || undefined,
            });
            await this.commit(key, blob, { meta, payload: bytes }, options, undefined);
            ok = true;
        } catch (error) {
            this.handleError(toError(error), "set");
            throw error;
        } finally {
            this.track("set", started, ok);
        }
    }

    /** A Blob stored with `setBlob` (`type` overrides the stored MIME type). */
    async getBlob(key: string, type?: string): Promise<Blob | null> {
        this.validKey(key);
        const result = await this.lookup(key, { blob: { type } });
        return result.hit ? (result.value as Blob) : null;
    }

    // ==============================
    // Batch Operations
    // ==============================

    /**
     * Write many entries in a SINGLE transaction (all-or-nothing). Plugin
     * `beforeSet` / `afterSet` hooks run for every item.
     */
    async batchSet<T>(items: BatchSetItem<T>[]): Promise<BatchResult<T>[]> {
        const started = perfNow();
        await this.ensureIndex();
        type Prepared = {
            item: BatchSetItem<T>;
            options: CacheSetOptions;
            record?: StoredRecord;
            rawSize?: number;
            error?: Error;
        };
        const prepared: Prepared[] = [];
        for (const item of items) {
            const options: CacheSetOptions = { ...item.options };
            try {
                this.validKey(item.key);
                if (!(await this.runBeforeSet(item.key, item.value, options))) {
                    prepared.push({
                        item,
                        options,
                        error: new CacheError("Rejected by a plugin", "PLUGIN_REJECTED"),
                    });
                    continue;
                }
                const built = await this.buildRecord(item.value, options);
                prepared.push({ item, options, record: built.record, rawSize: built.rawSize });
            } catch (error) {
                prepared.push({ item, options, error: toError(error) });
            }
        }

        // Last write wins for duplicate keys in one batch.
        const writable = prepared.filter(
            (p): p is Prepared & { record: StoredRecord } => !!p.record
        );
        if (writable.length) {
            try {
                await this.persist(
                    writable.map((p) => ({
                        type: "put" as const,
                        key: p.item.key,
                        meta: p.record.meta,
                        payload: p.record.payload,
                    })),
                    new Set(writable.map((p) => p.item.key))
                );
            } catch (error) {
                this.handleError(toError(error), "set");
                this.track("batchSet", started, false);
                throw error;
            }
            for (const p of writable) {
                this.pendingAccess.delete(p.item.key);
                const m = this.indexPut(p.item.key, p.record.meta);
                if (this.memory && p.rawSize !== undefined) {
                    this.memory.set(p.item.key, p.item.value, p.rawSize, m.expiresAt);
                }
                if (this.cfg.enableStats) this.stats.sets++;
            }
            await this.enforceBudgets().catch((err) => this.handleError(toError(err), "evict"));
            this.refreshCountStats();
            for (const p of writable) {
                try {
                    for (const plugin of this.plugins) {
                        if (plugin.afterSet) {
                            await plugin.afterSet(
                                p.item.key,
                                p.item.value,
                                this.entryView(
                                    { ...p.record.meta, key: p.item.key },
                                    p.record.payload
                                ),
                                p.options
                            );
                        }
                    }
                } catch (error) {
                    this.handleError(toError(error), "set");
                }
                this.emit("set", {
                    event: "set",
                    key: p.item.key,
                    value: p.item.value,
                    timestamp: Date.now(),
                });
                p.options.onSet?.(p.item.key, p.item.value);
            }
            this.broadcast(
                "set",
                writable.map((p) => p.item.key)
            );
        }
        this.track("batchSet", started, true);
        return prepared.map((p) =>
            p.record
                ? { key: p.item.key, value: p.item.value, success: true }
                : { key: p.item.key, value: null, success: false, error: p.error as Error }
        );
    }

    /** Read many keys; storage is read in ONE transaction. */
    async batchGet<T>(items: BatchGetItem[]): Promise<BatchResult<T>[]> {
        await this.ensureIndex();
        const prefetch = await this.prefetch(items.map((i) => i.key));
        const settled = await Promise.allSettled(
            items.map((item) => {
                const opt = item.options as CacheGetOptions<unknown> | undefined;
                return this.lookup(item.key, {
                    allowStale: opt?.staleWhileRevalidate === true,
                    updateAccess: opt?.updateAccessTime ?? true,
                    schema: opt?.schema,
                    opt,
                    prefetch,
                }).then((r) => {
                    if (r.hit && r.stale && opt?.revalidate)
                        this.revalidateInBackground(item.key, r.meta, opt);
                    return r;
                });
            })
        );
        return items.map((item, i) => {
            const result = settled[i] as PromiseSettledResult<Lookup>;
            if (result.status === "fulfilled") {
                return {
                    key: item.key,
                    value: result.value.hit ? (result.value.value as T) : null,
                    success: true,
                };
            }
            this.handleError(toError(result.reason), "get");
            return { key: item.key, value: null, success: false, error: toError(result.reason) };
        });
    }

    /** Read many keys (one storage transaction). Missing/expired → `null`. */
    async getMany<T>(keys: string[]): Promise<Map<string, T | null>> {
        const results = await this.batchGet<T>(keys.map((key) => ({ key })));
        const out = new Map<string, T | null>();
        for (const r of results) out.set(r.key, r.value);
        return out;
    }

    private async prefetch(keys: readonly string[]): Promise<Prefetch> {
        const nowMs = Date.now();
        const needed = [...new Set(keys)].filter((k) => {
            const m = this.meta.get(k);
            if (!m) return this.cfg.readThrough;
            // Fresh memory-tier hits need no storage read.
            return !(
                this.memory &&
                !isExpired(m.expiresAt, nowMs) &&
                this.memory.get(k, nowMs) !== undefined
            );
        });
        const records = needed.length ? await this.storage.get(this.ns, needed) : new Map();
        return { keys: new Set(needed), records };
    }

    async batchDelete(keys: string[]): Promise<BatchResult<null>[]> {
        await this.ensureIndex();
        const deleted = new Set(await this.deleteKeys(keys, true));
        return keys.map((key) => ({ key, value: null, success: deleted.has(key) }));
    }

    // ==============================
    // Query System
    // ==============================

    /** Filter + sort + paginate on in-memory metadata only (no payload reads). */
    private selectMetas(query: CacheQuery): CacheEntryMeta[] {
        let metas = Array.from(this.meta.values());
        const tags = query.tags;
        if (tags?.length) {
            metas =
                query.tagMode === "all"
                    ? metas.filter((m) => tags.every((t) => m.tags?.includes(t)))
                    : metas.filter((m) => tags.some((t) => m.tags?.includes(t)));
        }
        const nowMs = Date.now();
        const { minPriority, maxPriority, minAge, maxAge, minSize, maxSize, minAccessCount } =
            query;
        if (minPriority !== undefined)
            metas = metas.filter((m) => (m.priority ?? 0) >= minPriority);
        if (maxPriority !== undefined)
            metas = metas.filter((m) => (m.priority ?? 0) <= maxPriority);
        if (minAge !== undefined) metas = metas.filter((m) => getAge(m.createdAt, nowMs) >= minAge);
        if (maxAge !== undefined) metas = metas.filter((m) => getAge(m.createdAt, nowMs) <= maxAge);
        if (minSize !== undefined) metas = metas.filter((m) => m.size >= minSize);
        if (maxSize !== undefined) metas = metas.filter((m) => m.size <= maxSize);
        if (minAccessCount !== undefined)
            metas = metas.filter((m) => m.accessCount >= minAccessCount);
        const pattern = query.pattern;
        if (pattern) metas = metas.filter((m) => matchesPattern(m.key, pattern));
        if (query.expired !== undefined) {
            const wantExpired = query.expired;
            metas = metas.filter((m) => isExpired(m.expiresAt, nowMs) === wantExpired);
        }

        const sortBy = query.sortBy;
        if (sortBy) {
            const dir = query.sortOrder === "desc" ? -1 : 1;
            const sortValue = (m: CacheEntryMeta): number | string => {
                switch (sortBy) {
                    case "key":
                        return m.key;
                    case "createdAt":
                        return m.createdAt;
                    case "lastAccessed":
                        return m.lastAccessed;
                    case "accessCount":
                        return m.accessCount;
                    case "size":
                        return m.size;
                    case "priority":
                        return m.priority ?? 0;
                    case "expiresAt":
                        return m.expiresAt ?? Number.POSITIVE_INFINITY;
                }
            };
            // Compare explicitly: `Infinity - Infinity` is NaN and breaks sort().
            metas.sort((a, b) => {
                const av = sortValue(a);
                const bv = sortValue(b);
                return av < bv ? -dir : av > bv ? dir : 0;
            });
        }
        if (query.offset !== undefined) metas = metas.slice(query.offset);
        if (query.limit !== undefined) metas = metas.slice(0, query.limit);
        return metas;
    }

    /** Same filters as {@link query}, metadata only — no payload is read. */
    async queryMeta(query: CacheQuery = {}): Promise<CacheEntryMeta[]> {
        await this.ensureIndex();
        return this.selectMetas(query).map((m) => ({ ...m }));
    }

    async query<T>(query: CacheQuery = {}): Promise<QueryResult<T>[]> {
        await this.ensureIndex();
        const keys = this.selectMetas(query).map((m) => m.key);
        // Read only the page of results we return, in ONE transaction.
        const raw = keys.length
            ? await this.storage.get(this.ns, keys)
            : new Map<string, StoredRecord>();
        const results: QueryResult<T>[] = [];
        for (const key of keys) {
            const record = raw.get(key);
            if (!record) continue;
            try {
                const decoded = await this.decodeValue(key, record);
                if (!decoded.ok) continue;
                results.push({
                    key,
                    value: decoded.value as T,
                    entry: this.entryView({ ...record.meta, key }, record.payload) as CacheEntry<T>,
                });
            } catch {
                /* skip undecodable entries */
            }
        }
        return results;
    }

    // ==============================
    // Statistics
    // ==============================

    getStats(): CacheStats {
        return { ...this.stats };
    }

    async getDetailedStats(): Promise<DetailedStats> {
        await this.ensureIndex();
        const entriesByTag: Record<string, number> = {};
        const sizeByTag: Record<string, number> = {};
        let storedCompressed = 0;
        let originalCompressed = 0;
        let encryptedCount = 0;
        let expiredCount = 0;
        let oldestEntry: number | undefined;
        let newestEntry: number | undefined;
        let mostAccessed: { key: string; count: number } | undefined;
        let largestEntry: { key: string; size: number } | undefined;
        const nowMs = Date.now();

        for (const m of this.meta.values()) {
            for (const tag of m.tags ?? []) {
                entriesByTag[tag] = (entriesByTag[tag] ?? 0) + 1;
                sizeByTag[tag] = (sizeByTag[tag] ?? 0) + m.size;
            }
            if (m.isCompressed && m.originalSize !== undefined && m.originalSize > 0) {
                storedCompressed += m.size;
                originalCompressed += m.originalSize;
            }
            if (m.isEncrypted) encryptedCount++;
            if (isExpired(m.expiresAt, nowMs)) expiredCount++;
            if (oldestEntry === undefined || m.createdAt < oldestEntry) oldestEntry = m.createdAt;
            if (newestEntry === undefined || m.createdAt > newestEntry) newestEntry = m.createdAt;
            if (!mostAccessed || m.accessCount > mostAccessed.count) {
                mostAccessed = { key: m.key, count: m.accessCount };
            }
            if (!largestEntry || m.size > largestEntry.size)
                largestEntry = { key: m.key, size: m.size };
        }

        const latency: Record<string, LatencySummary> = {};
        for (const [op, window] of this.latency) latency[op] = window.summary();

        const result: DetailedStats = {
            ...this.stats,
            totalSize: this.currentSize,
            entryCount: this.meta.size,
            entriesByTag,
            sizeByTag,
            compressionRatio: originalCompressed > 0 ? storedCompressed / originalCompressed : 0,
            encryptedCount,
            expiredCount,
            latency,
            memoryEntries: this.memory?.size ?? 0,
        };
        if (oldestEntry !== undefined) result.oldestEntry = oldestEntry;
        if (newestEntry !== undefined) result.newestEntry = newestEntry;
        if (mostAccessed) result.mostAccessed = mostAccessed;
        if (largestEntry) result.largestEntry = largestEntry;
        return result;
    }

    resetStats(): void {
        this.stats = this.emptyStats();
        this.latency.clear();
        this.refreshCountStats();
    }

    private track(operation: string, started: number, success: boolean): void {
        const duration = perfNow() - started;
        let window = this.latency.get(operation);
        if (!window) {
            window = new LatencyWindow();
            this.latency.set(operation, window);
        }
        window.record(duration);
        if (this.eventListeners.get("operation")?.size) {
            this.emit("operation", {
                event: "operation",
                timestamp: Date.now(),
                metadata: { operation, duration, success },
            });
        }
    }

    // ==============================
    // Export / Import
    // ==============================

    /** A JSON-safe snapshot of this namespace. */
    async export(options?: ExportOptions): Promise<ExportData> {
        await this.ensureIndex();
        await this.flushAccessMetadata().catch(() => undefined);
        const nowMs = Date.now();
        const keys = Array.from(this.meta.values())
            .filter((m) => options?.includeExpired || !isExpired(m.expiresAt, nowMs))
            .map((m) => m.key);

        const entries: ExportedEntry[] = [];
        for (let i = 0; i < keys.length; i += 500) {
            const chunk = keys.slice(i, i + 500);
            const raw = await this.storage.get(this.ns, chunk);
            for (const key of chunk) {
                let record = raw.get(key);
                if (!record) continue;
                if (
                    options?.filter &&
                    !options.filter(key, this.entryView({ ...record.meta, key }, record.payload))
                ) {
                    continue;
                }
                if (options?.decrypt && record.meta.isEncrypted) {
                    record = await this.decryptRecord(record);
                }
                entries.push({
                    key,
                    meta: record.meta,
                    payload:
                        typeof record.payload === "string"
                            ? record.payload
                            : { b64: bytesToBase64(record.payload) },
                });
            }
        }

        const data: ExportData = {
            format: "cachecraft",
            formatVersion: 2,
            version: VERSION,
            timestamp: Date.now(),
            namespace: this.ns,
            entries,
        };
        const salt = await this.storage.getSystem("kdf-salt").catch(() => undefined);
        if (typeof salt === "string") data.salt = salt;
        if (this.cfg.enableStats) data.stats = this.getStats();
        return data;
    }

    /** {@link export} as a JSON string. */
    async exportJSON(options?: ExportOptions): Promise<string> {
        return JSON.stringify(await this.export(options));
    }

    /** {@link export} as a downloadable Blob (`application/json`). */
    async exportBlob(options?: ExportOptions): Promise<Blob> {
        return new Blob([await this.exportJSON(options)], { type: "application/json" });
    }

    private async decryptRecord(
        record: StoredRecord,
        ring: KeyRing = this.keyring
    ): Promise<StoredRecord> {
        const inner = await decryptPayload({ ...this.codec, keyring: ring }, record);
        const meta: StoredMeta = { ...record.meta, isEncrypted: false };
        delete meta.keyId;
        meta.size = typeof inner === "string" ? utf8ByteLength(inner) : inner.byteLength;
        return { meta, payload: inner };
    }

    private async encryptRecord(record: StoredRecord): Promise<StoredRecord> {
        const plain =
            typeof record.payload === "string"
                ? new TextEncoder().encode(record.payload)
                : record.payload;
        const { data, keyId } = await this.keyring.encrypt(plain);
        return {
            meta: { ...record.meta, isEncrypted: true, keyId, size: data.byteLength },
            payload: data,
        };
    }

    /**
     * Import an export (1.x format, or the ≤0.5 shape). Passphrase-encrypted
     * entries from another database are re-encrypted with this database's key.
     */
    async import(data: ExportData | LegacyExportData, options?: ImportOptions): Promise<number> {
        await this.ensureIndex();
        const overwrite = options?.overwrite === true || options?.merge === true;

        const incoming: Array<{ key: string; record: StoredRecord | undefined; error?: Error }> =
            [];
        if ((data as ExportData).format === "cachecraft") {
            const exported = data as ExportData;
            const foreignRing =
                exported.salt !== undefined
                    ? this.keyring.withSalt(decodeSalt(exported.salt))
                    : undefined;
            for (const e of exported.entries ?? []) {
                try {
                    if (
                        typeof e?.key !== "string" ||
                        typeof e.meta !== "object" ||
                        e.meta === null
                    ) {
                        throw new CacheError("Malformed export entry", "INVALID_ENTRY");
                    }
                    const meta = e.meta as StoredMeta;
                    if (!Number.isFinite(meta.size) || typeof meta.createdAt !== "number") {
                        throw new CacheError(
                            `Invalid cache entry for key "${e.key}"`,
                            "INVALID_ENTRY"
                        );
                    }
                    let record: StoredRecord = {
                        meta: { ...meta },
                        payload: payloadFromExport(e.payload),
                    };
                    if (record.meta.isEncrypted && record.meta.keyId !== undefined && foreignRing) {
                        // Encrypted under the source DB's salt: move it to our key.
                        try {
                            await this.keyring.decrypt(
                                record.payload as Uint8Array,
                                record.meta.keyId
                            );
                        } catch {
                            record = await this.encryptRecord(
                                await this.decryptRecord(record, foreignRing)
                            );
                        }
                    }
                    if (!record.meta.isEncrypted && options?.encrypt)
                        record = await this.encryptRecord(record);
                    incoming.push({ key: e.key, record });
                } catch (error) {
                    incoming.push({
                        key: String(e?.key),
                        record: undefined,
                        error: toError(error),
                    });
                }
            }
        } else {
            for (const [key, entry] of Object.entries((data as LegacyExportData).entries ?? {})) {
                let record = convertLegacy(entry);
                if (record && !record.meta.isEncrypted && options?.encrypt)
                    record = await this.encryptRecord(record);
                incoming.push(
                    record
                        ? { key, record }
                        : {
                              key,
                              record: undefined,
                              error: new CacheError(
                                  `Invalid cache entry for key "${key}"`,
                                  "INVALID_ENTRY"
                              ),
                          }
                );
            }
        }

        const firstError = incoming.find((i) => i.error);
        if (firstError && !options?.skipInvalid) throw firstError.error;

        let candidates = incoming.filter(
            (i): i is { key: string; record: StoredRecord } => !!i.record
        );
        if (!overwrite) {
            const existing = await this.storage.getMeta(
                this.ns,
                candidates.map((c) => c.key)
            );
            candidates = candidates.filter((c) => !existing.has(c.key) && !this.meta.has(c.key));
        }
        for (let i = 0; i < candidates.length; i += 200) {
            const chunk = candidates.slice(i, i + 200);
            await this.persist(
                chunk.map((c) => ({
                    type: "put" as const,
                    key: c.key,
                    meta: c.record.meta,
                    payload: c.record.payload,
                })),
                new Set(chunk.map((c) => c.key))
            );
            for (const c of chunk) {
                this.memory?.delete(c.key);
                this.indexPut(c.key, c.record.meta);
            }
        }
        await this.enforceBudgets().catch((err) => this.handleError(toError(err), "evict"));
        this.refreshCountStats();
        if (candidates.length) {
            this.emit("set", {
                event: "set",
                timestamp: Date.now(),
                metadata: { imported: candidates.length },
            });
            this.broadcast(
                "set",
                candidates.map((c) => c.key)
            );
        }
        return candidates.length;
    }

    /** Import from {@link exportJSON} output. */
    async importJSON(json: string, options?: ImportOptions): Promise<number> {
        return this.import(JSON.parse(json) as ExportData, options);
    }

    /** Import from a file / Blob produced by {@link exportBlob}. */
    async importBlob(blob: Blob, options?: ImportOptions): Promise<number> {
        return this.importJSON(await blob.text(), options);
    }

    // ==============================
    // Encryption key rotation
    // ==============================

    /**
     * Make `newKey` the encryption key and re-encrypt every encrypted entry of this
     * namespace with it (≤0.5 entries included). The previous key stays usable for
     * decryption in this engine; after rotating, put `newKey` in `encryptionKey`
     * (and the old one in `decryptionKeys` until other namespaces are rotated).
     * Returns the number of re-encrypted entries.
     */
    async rotateKey(newKey: string | CryptoKey): Promise<number> {
        await this.ensureIndex();
        this.keyring.setPrimary(newKey);
        await this.keyring.ready();
        const { keyId: primaryId } = await this.keyring.encrypt(new Uint8Array(1));
        const keys = Array.from(this.meta.values())
            .filter((m) => m.isEncrypted && m.keyId !== primaryId)
            .map((m) => m.key);
        let rotated = 0;
        for (let i = 0; i < keys.length; i += 100) {
            const chunk = keys.slice(i, i + 100);
            const raw = await this.storage.get(this.ns, chunk);
            const ops: WriteOp[] = [];
            for (const [key, record] of raw) {
                const re = await this.encryptRecord(await this.decryptRecord(record));
                // Keep the inner flags: decryptRecord/encryptRecord only swap the outer layer.
                re.meta.isCompressed = record.meta.isCompressed;
                ops.push({ type: "put", key, meta: re.meta, payload: re.payload });
            }
            await this.persist(ops, new Set(chunk));
            for (const op of ops) {
                if (op.type === "put") this.indexPut(op.key, op.meta);
            }
            rotated += ops.length;
            this.broadcast("set", chunk);
        }
        return rotated;
    }

    // ==============================
    // ≤0.5 data
    // ==============================

    /**
     * Move ≤0.5 entries of this namespace into the 1.x layout now (instead of on
     * first read). Keys are matched by prefix: `"ns:"` for a namespace, every key
     * for the root — so migrate namespaced engines before the root one.
     */
    async migrateLegacy(options?: { include?: (legacyKey: string) => boolean }): Promise<number> {
        await this.ensureIndex();
        if (!this.storage.legacyKeys || !this.storage.migrateLegacy) return 0;
        const prefix = this.ns ? `${this.ns}:` : "";
        const include = options?.include ?? ((k: string) => k.startsWith(prefix));
        let migrated = 0;
        for (const legacyKey of await this.storage.legacyKeys()) {
            if (!include(legacyKey)) continue;
            const key = legacyKey.slice(prefix.length);
            const record = await this.storage.migrateLegacy(this.ns, key, convertLegacy);
            if (record) {
                this.indexPut(key, record.meta);
                migrated++;
            }
        }
        if (migrated) {
            await this.enforceBudgets().catch((err) => this.handleError(toError(err), "evict"));
            this.refreshCountStats();
        }
        return migrated;
    }

    /** Delete all ≤0.5 data left in this store. Returns how many records were removed. */
    async dropLegacyData(): Promise<number> {
        return (await this.storage.dropLegacy?.()) ?? 0;
    }

    // ==============================
    // Eviction
    // ==============================

    private tagUsage(
        tag: string,
        exclude: ReadonlySet<string>
    ): { size: number; count: number; metas: CacheEntryMeta[] } {
        const metas: CacheEntryMeta[] = [];
        let size = 0;
        for (const key of this.tagIndex.get(tag) ?? []) {
            if (exclude.has(key)) continue;
            const m = this.meta.get(key);
            if (!m) continue;
            metas.push(m);
            size += m.size;
        }
        return { size, count: metas.length, metas };
    }

    /** Enforce size, entry-count and tag budgets. */
    private async enforceBudgets(): Promise<void> {
        const sizeOver = this.currentSize > this.cfg.maxSize;
        const countOver = this.meta.size > this.cfg.maxEntries;
        const tagOver = this.cfg.tagQuotas.some(([tag, q]) => {
            const set = this.tagIndex.get(tag);
            if (!set) return false;
            if (set.size > q.maxEntries) return true;
            if (q.maxSize === Number.POSITIVE_INFINITY) return false;
            return this.tagUsage(tag, new Set()).size > q.maxSize;
        });
        if (!sizeOver && !countOver && !tagOver) return;

        const metas = Array.from(this.meta.values());
        const chosen = new Set<string>();
        const choose = (m: CacheEntryMeta): void => {
            if (this.meta.has(m.key)) chosen.add(m.key);
        };

        if (sizeOver) {
            const target = this.cfg.maxSize * this.cfg.evictionTarget;
            for (const key of this.policy.shouldEvict(metas, target, this.currentSize)) {
                const m = this.meta.get(key);
                if (m) choose(m);
            }
        }
        if (countOver) {
            const targetCount = Math.min(
                Math.floor(this.cfg.maxEntries * this.cfg.evictionTarget),
                this.cfg.maxEntries
            );
            let need = this.meta.size - chosen.size - targetCount;
            if (need > 0) {
                for (const m of rankFor(this.policy, metas)) {
                    if (need <= 0) break;
                    if (chosen.has(m.key)) continue;
                    choose(m);
                    need--;
                }
            }
        }
        for (const [tag, quota] of this.cfg.tagQuotas) {
            const usage = this.tagUsage(tag, chosen);
            let { size, count } = usage;
            if (size <= quota.maxSize && count <= quota.maxEntries) continue;
            for (const m of rankFor(this.policy, usage.metas)) {
                if (size <= quota.maxSize && count <= quota.maxEntries) break;
                choose(m);
                size -= m.size;
                count--;
            }
        }
        if (chosen.size) await this.evictKeys([...chosen], "budget");
    }

    /** Evict roughly `bytes` (quota recovery). Returns bytes freed. */
    private async evictBytes(bytes: number, protect: ReadonlySet<string>): Promise<number> {
        const candidates = Array.from(this.meta.values()).filter((m) => !protect.has(m.key));
        const total = candidates.reduce((s, m) => s + m.size, 0);
        if (total === 0) return 0;
        const keys = this.policy
            .shouldEvict(candidates, Math.max(total - bytes, 0), total)
            .filter((k) => this.meta.has(k) && !protect.has(k));
        if (keys.length === 0) return 0;
        const freed = keys.reduce((s, k) => s + (this.meta.get(k)?.size ?? 0), 0);
        await this.evictKeys(keys, "quota");
        return freed;
    }

    private async evictKeys(keys: string[], reason: "budget" | "quota"): Promise<void> {
        const entries: CacheEntry[] = [];
        if (this.plugins.some((p) => p.onEvict)) {
            const raw = await this.storage
                .get(this.ns, keys)
                .catch(() => new Map<string, StoredRecord>());
            for (const [key, record] of raw)
                entries.push(this.entryView({ ...record.meta, key }, record.payload));
        }
        await this.storage.write(
            this.ns,
            keys.map((key) => ({ type: "delete", key }))
        );
        for (const key of keys) {
            if (this.forget(key) && this.cfg.enableStats) this.stats.evictions++;
        }
        this.emit("evict", {
            event: "evict",
            timestamp: Date.now(),
            metadata: { keys, count: keys.length, reason },
        });
        this.broadcast("evict", keys);
        for (const plugin of this.plugins) {
            if (plugin.onEvict) await plugin.onEvict(keys, entries);
        }
        this.refreshCountStats();
    }

    // ==============================
    // Cleanup & Maintenance
    // ==============================

    /** Delete expired entries. Returns how many were removed. */
    async cleanup(): Promise<number> {
        await this.ensureIndex();
        const nowMs = Date.now();
        const candidates = Array.from(this.meta.values())
            .filter((m) => isExpired(m.expiresAt, nowMs))
            .map((m) => m.key);
        if (candidates.length === 0) return 0;
        return (await this.expireKeys(candidates)).length;
    }

    /** (Re)start periodic cleanup (leader tab only, when Web Locks are available). */
    startAutoCleanup(): void {
        this.stopAutoCleanup();
        const start = (): void => {
            if (this.destroyed) return;
            this.cleanupIntervalId = setInterval(() => {
                this.cleanup().catch((err) => this.handleError(toError(err), "cleanup"));
            }, this.cfg.cleanupInterval);
            unref(this.cleanupIntervalId);
        };
        if (this.cfg.leaderCleanup && getLockManager()) {
            this.releaseLeader = acquireLeadership(
                `cachecraft-cleanup:${this.cfg.dbName}:${this.cfg.storeName}:${this.ns}`,
                start
            );
        } else {
            start();
        }
    }

    stopAutoCleanup(): void {
        if (this.cleanupIntervalId) {
            clearInterval(this.cleanupIntervalId);
            this.cleanupIntervalId = null;
        }
        this.releaseLeader?.();
        this.releaseLeader = null;
    }

    private startAccessFlush(): void {
        if (this.flushIntervalId) clearInterval(this.flushIntervalId);
        this.flushIntervalId = setInterval(
            () => this.flushQuietly(),
            this.cfg.accessMetadataFlushInterval
        );
        unref(this.flushIntervalId);
        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", this.onVisibilityChange);
        }
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            window.addEventListener("pagehide", this.onPageHide);
        }
    }

    private flushQuietly(): void {
        this.flushAccessMetadata().catch((err) => this.handleError(toError(err), "flush"));
    }

    /** Persist buffered access-time/count updates in one transaction. */
    async flushAccessMetadata(): Promise<void> {
        if (this.pendingAccess.size === 0) return;
        const pending = this.pendingAccess;
        this.pendingAccess = new Map();
        const ops: WriteOp[] = [];
        for (const [key, p] of pending) {
            ops.push({
                type: "touch",
                key,
                lastAccessed: p.lastAccessed,
                accessDelta: p.delta,
                expiresAt: p.expiresAt,
            });
        }
        try {
            await this.storage.write(this.ns, ops);
        } catch (error) {
            // Re-queue so updates aren't silently lost.
            for (const [key, p] of pending) {
                const cur = this.pendingAccess.get(key);
                if (cur) {
                    cur.delta += p.delta;
                    cur.lastAccessed = Math.max(cur.lastAccessed, p.lastAccessed);
                    if (cur.expiresAt === undefined && p.expiresAt !== undefined)
                        cur.expiresAt = p.expiresAt;
                } else {
                    this.pendingAccess.set(key, p);
                }
            }
            throw error;
        }
    }

    async getStorageInfo(): Promise<StorageInfo> {
        if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
            return {
                used: 0,
                available: 0,
                total: 0,
                percentage: 0,
                persisted: false,
                canGrow: false,
            };
        }
        const estimate = await navigator.storage.estimate();
        const used = estimate.usage ?? 0;
        const total = estimate.quota ?? 0;
        // `persisted()` only reads the state; `persist()` could show a prompt.
        const persisted =
            typeof navigator.storage.persisted === "function"
                ? await navigator.storage.persisted()
                : false;
        return {
            used,
            available: Math.max(total - used, 0),
            total,
            percentage: total > 0 ? used / total : 0,
            persisted,
            canGrow: persisted,
        };
    }

    /**
     * Ask the browser to keep this origin's storage under pressure
     * (`navigator.storage.persist()`). May show a permission prompt in Firefox.
     */
    async requestPersistence(): Promise<boolean> {
        if (typeof navigator === "undefined" || typeof navigator.storage?.persist !== "function") {
            return false;
        }
        return navigator.storage.persist();
    }

    async getHealth(): Promise<HealthStatus> {
        const issues: string[] = [];
        try {
            await this.ensureIndex();
            const storageInfo = await this.getStorageInfo();
            if (storageInfo.percentage > 0.9) issues.push("Storage usage above 90%");
            if (this.currentSize > this.cfg.maxSize * 0.9)
                issues.push("Cache size near configured limit");
            if (this.meta.size > this.cfg.maxEntries * 0.9)
                issues.push("Entry count near configured limit");
            if (await this.storage.hasLegacy?.().catch(() => false)) {
                issues.push(
                    "Data from CacheCraft ≤0.5 is still stored (call migrateLegacy() or dropLegacyData())"
                );
            }
            const health: HealthStatus = {
                isHealthy: issues.length === 0,
                uptime: Date.now() - this.startTime,
                dbConnected: true,
                size: this.currentSize,
                entryCount: this.meta.size,
                issues,
            };
            if (this.lastError) health.lastError = this.lastError;
            return health;
        } catch (error) {
            return {
                isHealthy: false,
                uptime: Date.now() - this.startTime,
                dbConnected: false,
                size: 0,
                entryCount: 0,
                issues: ["Storage connection failed"],
                lastError: toError(error),
            };
        }
    }

    // ==============================
    // Plugin System
    // ==============================

    /** The engine surface handed to plugins. */
    private get host(): CachePluginHost {
        return {
            set: (key, value, options) => this.set(key, value, options),
            has: (key) => this.has(key),
            namespace: this.ns,
        };
    }

    use(plugin: CachePlugin): void {
        this.plugins.push(plugin);
        try {
            plugin.init?.(this.host);
        } catch (error) {
            this.handleError(toError(error), "init");
        }
    }

    removePlugin(name: string): boolean {
        const index = this.plugins.findIndex((p) => p.name === name);
        if (index === -1) return false;
        this.plugins.splice(index, 1);
        return true;
    }

    getPlugins(): CachePlugin[] {
        return [...this.plugins];
    }

    // ==============================
    // Event System
    // ==============================

    on(event: CacheEvent, listener: CacheEventListener): () => void {
        let set = this.eventListeners.get(event);
        if (!set) {
            set = new Set();
            this.eventListeners.set(event, set);
        }
        set.add(listener);
        return () => this.off(event, listener);
    }

    off(event: CacheEvent, listener: CacheEventListener): void {
        this.eventListeners.get(event)?.delete(listener);
    }

    once(event: CacheEvent, listener: CacheEventListener): () => void {
        const onceListener: CacheEventListener = (data) => {
            this.off(event, onceListener);
            listener(data);
        };
        return this.on(event, onceListener);
    }

    private emit(event: CacheEvent, data: CacheEventData): void {
        const listeners = this.eventListeners.get(event);
        if (!listeners) return;
        for (const listener of Array.from(listeners)) {
            try {
                listener(data);
            } catch (error) {
                // A throwing "error" listener must not re-enter handleError → emit("error").
                if (event !== "error") this.handleError(toError(error), "listener");
            }
        }
    }

    // ==============================
    // Sync System
    // ==============================

    private broadcast(type: SyncMessageType, keys?: readonly string[]): void {
        if (!this.broadcastChannel) return;
        const message: SyncMessage = {
            type,
            namespace: this.ns,
            store: this.cfg.storeName,
            timestamp: Date.now(),
            source: this.id,
        };
        if (keys?.length === 1) message.key = keys[0] as string;
        else if (keys) message.keys = [...keys];
        try {
            // Values are never sent: receivers re-read storage (no large clones, no plaintext).
            this.broadcastChannel.postMessage(message);
        } catch (error) {
            this.handleError(toError(error), "sync");
        }
    }

    private async handleSyncMessage(message: SyncMessage): Promise<void> {
        if (!message || typeof message !== "object" || this.destroyed) return;
        if (message.source === this.id) return;
        // The channel is shared by every store and namespace of one database.
        if ((message.store ?? "cache") !== this.cfg.storeName) return;
        if ((message.namespace ?? "") !== this.ns) return;
        if (!this.indexReady) return; // nothing loaded yet — hydration will read fresh state

        try {
            await this.indexReady;
            const keys = message.key !== undefined ? [message.key] : (message.keys ?? []);
            switch (message.type) {
                case "set": {
                    for (const key of keys) this.memory?.delete(key);
                    const metas = await this.storage.getMeta(this.ns, keys);
                    for (const key of keys) {
                        const stored = metas.get(key);
                        if (stored) this.indexPut(key, stored);
                        else this.forget(key);
                    }
                    break;
                }
                case "delete":
                case "evict":
                    for (const key of keys) this.forget(key);
                    break;
                case "clear":
                    this.resetIndex();
                    this.memory?.clear();
                    break;
            }
            this.refreshCountStats();
            if (keys.length <= 1) {
                this.emit("sync", {
                    event: "sync",
                    ...(keys[0] !== undefined ? { key: keys[0] } : {}),
                    timestamp: message.timestamp,
                    metadata: { type: message.type },
                });
            } else {
                for (const key of keys) {
                    this.emit("sync", {
                        event: "sync",
                        key,
                        timestamp: message.timestamp,
                        metadata: { type: message.type },
                    });
                }
            }
        } catch (error) {
            this.handleError(toError(error), "sync");
        }
    }

    // ==============================
    // Internals
    // ==============================

    private refreshCountStats(): void {
        if (!this.cfg.enableStats) return;
        this.stats.totalSize = this.currentSize;
        this.stats.entryCount = this.meta.size;
        this.recomputeRates();
    }

    private recomputeRates(): void {
        const total = this.stats.hits + this.stats.misses;
        this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
        this.stats.missRate = total > 0 ? this.stats.misses / total : 0;
    }

    private handleError(error: Error, operation = "unknown"): void {
        this.lastError = error;
        if (this.cfg.enableStats) this.stats.errors++;
        this.emit("error", {
            event: "error",
            timestamp: Date.now(),
            error,
            metadata: { operation },
        });
        try {
            this.cfg.onError(error);
        } catch {
            /* a faulty onError must never break the engine */
        }
        for (const plugin of this.plugins) {
            try {
                Promise.resolve(plugin.onError?.(error, operation)).catch(() => undefined);
            } catch {
                /* ignore plugin failures while reporting */
            }
        }
    }

    private emptyStats(): CacheStats {
        return {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0,
            evictions: 0,
            errors: 0,
            totalSize: 0,
            entryCount: 0,
            hitRate: 0,
            missRate: 0,
            avgAccessTime: 0,
            memoryHits: 0,
        };
    }

    // ==============================
    // Lifecycle
    // ==============================

    /** Flush pending writes, stop timers, close channels and release storage. */
    async destroy(): Promise<void> {
        if (this.destroyed) return;
        this.stopAutoCleanup();
        if (this.flushIntervalId) {
            clearInterval(this.flushIntervalId);
            this.flushIntervalId = null;
        }
        if (typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", this.onVisibilityChange);
        }
        if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
            window.removeEventListener("pagehide", this.onPageHide);
        }
        if (this.indexReady) await this.flushAccessMetadata().catch(() => undefined);
        this.destroyed = true;

        this.broadcastChannel?.close();
        this.broadcastChannel = null;
        this.eventListeners.clear();
        this.plugins = [];
        this.resetIndex();
        this.memory?.clear();
        for (const flight of this.inflight.values()) {
            flight.controller.abort(new CacheError("Cache engine destroyed", "DESTROYED"));
        }
        this.inflight.clear();
        this.revalidating.clear();
        this.indexReady = null;
        unregisterEngine(this);
        this.releaseStorage();
    }

    /** True after {@link destroy}. */
    get isDestroyed(): boolean {
        return this.destroyed;
    }
}
