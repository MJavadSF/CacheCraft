"use client";

// ==============================
// CacheCraft React Adapter — `import { useCache } from "cache-craft-engine/react"`
//
// SSR-safe: every browser-only effect is guarded so it is inert on the server.
// Requires React 18+ (useSyncExternalStore).
// ==============================

import {
    createContext,
    createElement,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import { CacheEngine } from "./cache-engine";
import type { DevtoolsOptions } from "./devtools";
import type {
    CacheConfig,
    CacheEvent,
    CacheEventData,
    CacheFactory,
    CacheSetOptions,
    CacheStats,
    GetOrSetOptions,
} from "./types";
import { isSSR, toError } from "./utils";

function isProduction(): boolean {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
        ?.env;
    return env?.NODE_ENV === "production";
}

// ------------------------------
// Shared engines: hooks reading the same (dbName, storeName, namespace) share one
// engine (one index, one connection).
// ------------------------------

const engineRegistry = new Map<string, { engine: CacheEngine; config: CacheConfig | undefined }>();

function registryKey(config?: CacheConfig): string {
    return `${config?.dbName ?? "cache-db"}::${config?.storeName ?? "cache"}::${config?.namespace ?? ""}`;
}

function sameConfig(a: CacheConfig | undefined, b: CacheConfig | undefined): boolean {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const key of keys) {
        const av = (a as Record<string, unknown> | undefined)?.[key];
        const bv = (b as Record<string, unknown> | undefined)?.[key];
        if (av !== bv && JSON.stringify(av) !== JSON.stringify(bv)) return false;
    }
    return true;
}

/** Get (or lazily create) the shared engine for a config. `null` during SSR. */
export function getSharedCache(config?: CacheConfig): CacheEngine | null {
    if (isSSR()) return null;
    const key = registryKey(config);
    const existing = engineRegistry.get(key);
    if (existing && !existing.engine.isDestroyed) {
        if (!sameConfig(existing.config, config) && !isProduction()) {
            console.warn(
                `[cache-craft] getSharedCache("${key}") was called with a different config than the ` +
                    "engine that already exists for it; the existing engine (and its config) is reused."
            );
        }
        return existing.engine;
    }
    const engine = new CacheEngine(config);
    engineRegistry.set(key, { engine, config });
    return engine;
}

/** Destroy every shared engine (tests, logout). */
export async function disposeSharedCaches(): Promise<void> {
    const engines = [...engineRegistry.values()].map((e) => e.engine);
    engineRegistry.clear();
    await Promise.all(engines.map((e) => e.destroy()));
}

// ------------------------------
// Provider
// ------------------------------

type ProviderValue = { engine?: CacheEngine | null; config?: CacheConfig };

const CacheContext = createContext<ProviderValue | null>(null);

export type CacheProviderProps = {
    /** The engine every hook below uses by default. */
    engine?: CacheEngine | null;
    /** Or: a config for a shared engine. */
    config?: CacheConfig;
    children?: ReactNode;
};

/** Sets the default engine (or config) for every hook in the subtree. */
export function CacheProvider(props: CacheProviderProps): ReactNode {
    const configKey = registryKey(props.config);
    const configRef = useRef(props.config);
    configRef.current = props.config;
    // The config is identified by its registry key (inline objects are new every render).
    const value = useMemo<ProviderValue>(
        () => ({ engine: props.engine, config: configKey ? configRef.current : undefined }),
        [props.engine, configKey]
    );
    return createElement(CacheContext.Provider, { value }, props.children);
}

/**
 * Stable engine for a component: the explicit one, else the provider's, else the
 * shared engine for `config`. `null` during SSR.
 */
export function useCacheEngine(
    config?: CacheConfig,
    explicit?: CacheEngine | null
): CacheEngine | null {
    const ctx = useContext(CacheContext);
    const effectiveConfig = config ?? ctx?.config;
    const key = registryKey(effectiveConfig);
    const fromContext = config ? undefined : ctx?.engine;
    // biome-ignore lint/correctness/useExhaustiveDependencies: the config is identified by its registry key
    return useMemo(
        () => explicit ?? fromContext ?? getSharedCache(effectiveConfig),
        [explicit, fromContext, key]
    );
}

// ------------------------------
// useCache — cache-aside data fetching with SWR-style ergonomics.
// ------------------------------

export type MutateOptions = {
    /** Restore the previous value if persisting fails. Default: true. */
    rollbackOnError?: boolean;
    /** Options for the write (default: the hook's options). */
    setOptions?: CacheSetOptions;
};

export type UseCacheState<T> = {
    data: T | undefined;
    error: Error | null;
    /** No data yet and a request is in flight. */
    isLoading: boolean;
    /** Any request in flight (including background refreshes). */
    isValidating: boolean;
    /** Re-run the factory and update the cache (the cached value survives a failure). */
    refresh: () => Promise<void>;
    /** Remove this key; mounted `useCache` hooks for it refetch. */
    invalidate: () => Promise<void>;
    /** Write a value (or an updater of the current one) to state and cache, optimistically. */
    mutate: (value: T | ((current: T | undefined) => T), options?: MutateOptions) => Promise<void>;
};

export type UseCacheOptions<T> = GetOrSetOptions<T> & {
    /** Skip fetching while false. Default: true. */
    enabled?: boolean;
    /** Revalidate when the tab becomes visible / the window regains focus. Default: false. */
    revalidateOnFocus?: boolean;
    /** Revalidate when the browser comes back online. Default: false. */
    revalidateOnReconnect?: boolean;
    /** Revalidate every N ms while visible (0/undefined = off). */
    refreshInterval?: number;
    /** Shown until the first result (e.g. data from a Server Component). Not cached. */
    fallbackData?: T;
    /** Keep showing the previous key's data while the new key loads. Default: false. */
    keepPreviousData?: boolean;
    /** Engine config when not using an explicit engine / provider. */
    config?: CacheConfig;
    /** Explicit engine (overrides config and provider). */
    engine?: CacheEngine | null;
};

const HOOK_ONLY_KEYS = [
    "enabled",
    "revalidateOnFocus",
    "revalidateOnReconnect",
    "refreshInterval",
    "fallbackData",
    "keepPreviousData",
    "config",
    "engine",
] as const;

/** Strip the hook-only options so only real cache options reach the engine. */
function toCacheOptions<T>(options?: UseCacheOptions<T>): GetOrSetOptions<T> {
    if (!options) return {};
    const out: Record<string, unknown> = { ...options };
    for (const key of HOOK_ONLY_KEYS) delete out[key];
    return out as GetOrSetOptions<T>;
}

function onVisible(handler: () => void): () => void {
    const onVisibility = (): void => {
        if (document.visibilityState === "visible") handler();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", handler);
    return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("focus", handler);
    };
}

export function useCache<T>(
    key: string | null,
    factory: CacheFactory<T>,
    options?: UseCacheOptions<T>
): UseCacheState<T> {
    const engine = useCacheEngine(options?.config, options?.engine);
    const enabled = (options?.enabled ?? true) && key !== null;

    const [data, setData] = useState<T | undefined>(undefined);
    const [error, setError] = useState<Error | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(enabled);
    const [isValidating, setIsValidating] = useState<boolean>(false);
    const [hasResult, setHasResult] = useState(false);

    // Always read the latest factory/options without retriggering effects.
    const factoryRef = useRef(factory);
    factoryRef.current = factory;
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const dataRef = useRef<T | undefined>(undefined);
    dataRef.current = data;

    // Only the most recent request (for the current key) may update state.
    const requestRef = useRef(0);

    const load = useCallback(
        async (force = false) => {
            if (!engine || key === null) return;
            const request = ++requestRef.current;
            const isCurrent = (): boolean => request === requestRef.current;
            const cacheOptions = toCacheOptions(optionsRef.current);
            setIsValidating(true);
            try {
                const value = await engine.getOrSet<T>(key, (ctx) => factoryRef.current(ctx), {
                    ...cacheOptions,
                    // A failed refresh leaves the cached value (and the shown data) intact.
                    forceRefresh: force || cacheOptions.forceRefresh,
                });
                if (!isCurrent()) return;
                setData(value);
                setHasResult(true);
                setError(null);
            } catch (err) {
                if (isCurrent()) setError(toError(err));
            } finally {
                if (isCurrent()) {
                    setIsLoading(false);
                    setIsValidating(false);
                }
            }
        },
        [engine, key]
    );

    useEffect(() => {
        // A different key must never show the previous key's data (unless asked to).
        if (!optionsRef.current?.keepPreviousData) {
            setData(undefined);
            setHasResult(false);
        }
        setError(null);
        if (!enabled) {
            requestRef.current++; // invalidate in-flight requests
            setIsLoading(false);
            setIsValidating(false);
            return;
        }
        setIsLoading(true);
        void load();
        return () => {
            requestRef.current++; // ignore results after unmount / key change
        };
    }, [enabled, load]);

    // Keep every hook on this key in sync with writes from anywhere (incl. other tabs).
    useEffect(() => {
        if (!engine || key === null || !enabled) return;
        const offs: Array<() => void> = [];
        const onSet = (e: CacheEventData): void => {
            if (e.key !== key) return;
            if ("value" in e && e.value !== undefined) {
                setData(e.value as T);
                setHasResult(true);
            }
        };
        const onSync = (e: CacheEventData): void => {
            if (e.key !== undefined && e.key !== key) return;
            engine
                .peek<T>(key)
                .then((v) => {
                    if (v !== null) {
                        setData(v);
                        setHasResult(true);
                    } else void load();
                })
                .catch(() => undefined);
        };
        const onDelete = (e: CacheEventData): void => {
            if (e.key === undefined || e.key === key) void load();
        };
        offs.push(engine.on("set", onSet), engine.on("sync", onSync));
        offs.push(engine.on("delete", onDelete), engine.on("clear", onDelete));
        return () => {
            for (const off of offs) off();
        };
    }, [engine, key, enabled, load]);

    const revalidateOnFocus = options?.revalidateOnFocus ?? false;
    useEffect(() => {
        if (!revalidateOnFocus || isSSR() || !enabled) return;
        return onVisible(() => void load());
    }, [revalidateOnFocus, enabled, load]);

    const revalidateOnReconnect = options?.revalidateOnReconnect ?? false;
    useEffect(() => {
        if (!revalidateOnReconnect || isSSR() || !enabled) return;
        const handler = (): void => void load(true);
        window.addEventListener("online", handler);
        return () => window.removeEventListener("online", handler);
    }, [revalidateOnReconnect, enabled, load]);

    const refreshInterval = options?.refreshInterval ?? 0;
    useEffect(() => {
        if (!refreshInterval || isSSR() || !enabled) return;
        const id = setInterval(() => {
            if (typeof document === "undefined" || document.visibilityState !== "hidden")
                void load(true);
        }, refreshInterval);
        return () => clearInterval(id);
    }, [refreshInterval, enabled, load]);

    const refresh = useCallback(() => load(true), [load]);

    const invalidate = useCallback(async () => {
        if (!engine || key === null) return;
        await engine.remove(key); // the delete listener refetches
    }, [engine, key]);

    const mutate = useCallback(
        async (value: T | ((current: T | undefined) => T), mutateOptions?: MutateOptions) => {
            if (!engine || key === null) return;
            const previous = dataRef.current;
            const next =
                typeof value === "function"
                    ? (value as (current: T | undefined) => T)(previous)
                    : value;
            setData(next);
            setHasResult(true);
            try {
                await engine.set(
                    key,
                    next,
                    mutateOptions?.setOptions ??
                        (toCacheOptions(optionsRef.current) as CacheSetOptions)
                );
            } catch (err) {
                if (mutateOptions?.rollbackOnError ?? true) setData(previous);
                setError(toError(err));
                throw err;
            }
        },
        [engine, key]
    );

    const shown = hasResult || data !== undefined ? data : options?.fallbackData;
    return {
        data: shown,
        error,
        isLoading: isLoading && shown === undefined,
        isValidating,
        refresh,
        invalidate,
        mutate,
    };
}

// ------------------------------
// Suspense
// ------------------------------

type SuspenseRecord =
    | { status: "pending"; promise: Promise<unknown> }
    | { status: "done"; value: unknown }
    | { status: "error"; error: Error };

const suspenseRecords = new Map<string, SuspenseRecord>();

/**
 * Suspense flavour of {@link useCache}: suspends until the value is available and
 * returns it (errors go to the nearest error boundary). Client components only.
 */
export function useSuspenseCache<T>(
    key: string,
    factory: CacheFactory<T>,
    options?: Omit<UseCacheOptions<T>, "enabled" | "fallbackData" | "keepPreviousData">
): { data: T; refresh: () => Promise<void>; mutate: UseCacheState<T>["mutate"] } {
    const engine = useCacheEngine(options?.config, options?.engine);
    if (!engine) {
        throw new Error("useSuspenseCache needs a browser engine (it cannot run during SSR)");
    }
    const id = `${engine.id}\u0000${key}`;
    const [, force] = useState(0);

    useEffect(() => {
        const drop = (e: CacheEventData): void => {
            if (e.key !== undefined && e.key !== key) return;
            const record = suspenseRecords.get(id);
            if (e.event === "set" && "value" in e && e.value !== undefined) {
                suspenseRecords.set(id, { status: "done", value: e.value });
            } else if (record?.status !== "pending") {
                suspenseRecords.delete(id);
            }
            force((n) => n + 1);
        };
        const offs = (["set", "delete", "clear", "sync"] as CacheEvent[]).map((ev) =>
            engine.on(ev, drop)
        );
        return () => {
            for (const off of offs) off();
        };
    }, [engine, id, key]);

    let record = suspenseRecords.get(id);
    if (!record) {
        const promise = engine.getOrSet<T>(key, factory, toCacheOptions(options)).then(
            (value) => {
                suspenseRecords.set(id, { status: "done", value });
            },
            (error) => {
                suspenseRecords.set(id, { status: "error", error: toError(error) });
            }
        );
        record = { status: "pending", promise };
        suspenseRecords.set(id, record);
    }
    if (record.status === "pending") throw record.promise;
    if (record.status === "error") {
        // Keep the error briefly so React's own re-render retries see the same error,
        // then forget it so a remount (error boundary reset) tries again.
        const failed = record;
        const timer = setTimeout(() => {
            if (suspenseRecords.get(id) === failed) suspenseRecords.delete(id);
        }, 1000);
        (timer as { unref?: () => void }).unref?.();
        throw record.error;
    }

    const refresh = async (): Promise<void> => {
        const value = await engine.getOrSet<T>(key, factory, {
            ...toCacheOptions(options),
            forceRefresh: true,
        });
        suspenseRecords.set(id, { status: "done", value });
        force((n) => n + 1);
    };
    const mutate: UseCacheState<T>["mutate"] = async (value) => {
        const current = (suspenseRecords.get(id) as { value?: T } | undefined)?.value;
        const next =
            typeof value === "function" ? (value as (c: T | undefined) => T)(current) : value;
        await engine.set(key, next, toCacheOptions(options) as CacheSetOptions);
    };
    return { data: record.value as T, refresh, mutate };
}

/** Warm the cache before rendering (route loaders, hover prefetch…). */
export function prefetchCache<T>(
    engine: CacheEngine,
    key: string,
    factory: CacheFactory<T>,
    options?: GetOrSetOptions<T>
): Promise<T> {
    return engine.getOrSet(key, factory, options);
}

// ------------------------------
// useCacheValue — read-only view of one key, live across writes and tabs.
// ------------------------------

export function useCacheValue<T>(
    key: string | null,
    options?: { config?: CacheConfig; engine?: CacheEngine | null }
): T | undefined {
    const engine = useCacheEngine(options?.config, options?.engine);
    const [snapshot, setSnapshot] = useState<T | undefined>(undefined);

    useEffect(() => {
        setSnapshot(undefined);
        if (!engine || key === null) return;
        let active = true;
        const read = (): void => {
            // Observing is not a use: no access-time bump, no stats.
            engine
                .peek<T>(key)
                .then((v) => {
                    if (active) setSnapshot(v ?? undefined);
                })
                .catch(() => undefined);
        };
        read();
        const relevant: CacheEvent[] = ["set", "delete", "clear", "sync", "expire", "evict"];
        const listener = (data: CacheEventData): void => {
            const keys = (data.metadata as { keys?: string[] } | undefined)?.keys;
            if (data.key === undefined ? !keys || keys.includes(key) : data.key === key) read();
        };
        const offs = relevant.map((e) => engine.on(e, listener));
        return () => {
            active = false;
            for (const off of offs) off();
        };
    }, [engine, key]);

    return snapshot;
}

// ------------------------------
// useCacheStats — live stats, throttled.
// ------------------------------

export function useCacheStats(options?: {
    config?: CacheConfig;
    engine?: CacheEngine | null;
    /** Re-render at most every N ms. Default: 250. */
    throttleMs?: number;
}): CacheStats | null {
    const engine = useCacheEngine(options?.config, options?.engine);
    const throttleMs = options?.throttleMs ?? 250;

    // getSnapshot must return a STABLE reference until the store changes.
    const snapshotRef = useRef<{ engine: CacheEngine; stats: CacheStats } | null>(null);

    const subscribe = useCallback(
        (onChange: () => void) => {
            if (!engine) return () => undefined;
            let timer: ReturnType<typeof setTimeout> | null = null;
            let last = 0;
            const commit = (): void => {
                timer = null;
                last = Date.now();
                snapshotRef.current = { engine, stats: engine.getStats() };
                onChange();
            };
            const handler = (): void => {
                if (timer !== null) return;
                const wait = Math.max(throttleMs - (Date.now() - last), 0);
                if (wait === 0) commit();
                else timer = setTimeout(commit, wait);
            };
            const events: CacheEvent[] = [
                "set",
                "get",
                "delete",
                "clear",
                "evict",
                "hit",
                "miss",
                "sync",
                "expire",
            ];
            const offs = events.map((e) => engine.on(e, handler));
            return () => {
                if (timer !== null) clearTimeout(timer);
                for (const off of offs) off();
            };
        },
        [engine, throttleMs]
    );

    const getSnapshot = useCallback((): CacheStats | null => {
        if (!engine) return null;
        if (snapshotRef.current?.engine !== engine) {
            snapshotRef.current = { engine, stats: engine.getStats() };
        }
        return snapshotRef.current.stats;
    }, [engine]);

    const getServerSnapshot = useCallback((): CacheStats | null => null, []);
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ------------------------------
// Devtools
// ------------------------------

/**
 * Mount the CacheCraft devtools panel while the component is mounted. The panel
 * code is loaded lazily (its own chunk) and only when `enabled` (default: true in
 * development, false in production).
 */
export function useCacheDevtools(options: DevtoolsOptions & { enabled?: boolean } = {}): void {
    const enabled = options.enabled ?? !isProduction();
    const optionsRef = useRef(options);
    optionsRef.current = options;
    useEffect(() => {
        if (!enabled || isSSR()) return;
        let dispose: (() => void) | undefined;
        let cancelled = false;
        void import("./devtools").then((m) => {
            if (!cancelled) dispose = m.mountDevtools(optionsRef.current).destroy;
        });
        return () => {
            cancelled = true;
            dispose?.();
        };
    }, [enabled]);
}
