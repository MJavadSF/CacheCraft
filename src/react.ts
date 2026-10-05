"use client";

// ==============================
// CacheCraft React Adapter
//
// Optional entry point: `import { useCache } from "cache-craft-engine/react"`.
// SSR-safe — every browser-only effect is guarded so it is inert on the server.
// Requires React 18+ (uses useSyncExternalStore).
// ==============================

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CacheEngine } from "./cache-engine";
import type {
    CacheConfig,
    CacheEvent,
    CacheSetOptions,
    CacheStats,
    GetOrSetOptions,
} from "./types";
import { isSSR, toError } from "./utils";

// ------------------------------
// Shared per-config singletons so multiple hooks/components reading the same
// dbName share one engine (and therefore one in-memory index + cache).
// ------------------------------

const engineRegistry = new Map<string, CacheEngine>();

function registryKey(config?: CacheConfig): string {
    return `${config?.dbName ?? "cache-db"}::${config?.namespace ?? ""}::${config?.storeName ?? "cache"}`;
}

/**
 * Get (or lazily create) a shared CacheEngine for a given config.
 * Returns null during SSR.
 */
export function getSharedCache(config?: CacheConfig): CacheEngine | null {
    if (isSSR()) return null;
    const key = registryKey(config);
    let engine = engineRegistry.get(key);
    if (!engine) {
        engine = new CacheEngine(config);
        engineRegistry.set(key, engine);
    }
    return engine;
}

// ------------------------------
// useCacheEngine — stable engine reference for a component tree. Follows the
// config when `dbName` / `namespace` / `storeName` change, and never creates a
// shared engine when an explicit one is supplied.
// ------------------------------

export function useCacheEngine(
    config?: CacheConfig,
    explicit?: CacheEngine | null
): CacheEngine | null {
    const key = registryKey(config);
    // biome-ignore lint/correctness/useExhaustiveDependencies: the config is identified by its registry key
    return useMemo(() => explicit ?? getSharedCache(config), [explicit, key]);
}

// ------------------------------
// useCache — cache-aside data fetching hook with SWR-style ergonomics.
// ------------------------------

export type UseCacheState<T> = {
    data: T | undefined;
    error: Error | null;
    isLoading: boolean;
    isValidating: boolean;
    /** Re-run the factory and update the cache. */
    refresh: () => Promise<void>;
    /** Remove this key from the cache. */
    invalidate: () => Promise<void>;
    /** Optimistically write a value to the cache and local state. */
    mutate: (value: T) => Promise<void>;
};

export type UseCacheOptions<T> = GetOrSetOptions<T> & {
    /** Skip fetching while false (e.g. waiting on a dependency). Default: true. */
    enabled?: boolean;
    /** Re-validate when the window regains focus. Default: false. */
    revalidateOnFocus?: boolean;
    /** Engine config when not using an explicit engine. */
    config?: CacheConfig;
    /** Explicit engine (overrides config). */
    engine?: CacheEngine | null;
};

/** Strip the hook-only options so only real cache options reach the engine. */
function toCacheOptions<T>(options?: UseCacheOptions<T>): GetOrSetOptions<T> {
    if (!options) return {};
    const {
        enabled: _e,
        revalidateOnFocus: _r,
        config: _c,
        engine: _en,
        ...cacheOptions
    } = options;
    return cacheOptions;
}

export function useCache<T>(
    key: string | null,
    factory: () => Promise<T> | T,
    options?: UseCacheOptions<T>
): UseCacheState<T> {
    const engine = useCacheEngine(options?.config, options?.engine);
    const enabled = (options?.enabled ?? true) && key !== null;

    const [data, setData] = useState<T | undefined>(undefined);
    const [error, setError] = useState<Error | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(enabled);
    const [isValidating, setIsValidating] = useState<boolean>(false);

    // Always read the latest factory/options without retriggering effects.
    const factoryRef = useRef(factory);
    factoryRef.current = factory;
    const optionsRef = useRef(options);
    optionsRef.current = options;

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
                let value: T;
                if (force) {
                    // Refresh in place: if the factory fails, the cached value survives.
                    value = await factoryRef.current();
                    await engine.set(key, value, cacheOptions as CacheSetOptions);
                } else {
                    value = await engine.getOrSet<T>(key, () => factoryRef.current(), cacheOptions);
                }
                if (!isCurrent()) return;
                setData(value);
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
        // A different key must never show the previous key's data.
        setData(undefined);
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

    // Revalidate on focus.
    const revalidateOnFocus = options?.revalidateOnFocus ?? false;
    useEffect(() => {
        if (!revalidateOnFocus || isSSR() || !enabled) return;
        const handler = (): void => void load();
        window.addEventListener("focus", handler);
        return () => window.removeEventListener("focus", handler);
    }, [revalidateOnFocus, enabled, load]);

    const refresh = useCallback(() => load(true), [load]);

    const invalidate = useCallback(async () => {
        if (!engine || key === null) return;
        await engine.remove(key);
        setData(undefined);
    }, [engine, key]);

    const mutate = useCallback(
        async (value: T) => {
            if (!engine || key === null) return;
            setData(value);
            await engine.set(key, value, toCacheOptions(optionsRef.current) as CacheSetOptions);
        },
        [engine, key]
    );

    return { data, error, isLoading, isValidating, refresh, invalidate, mutate };
}

// ------------------------------
// useCacheValue — subscribe to a single key, reflecting cross-tab + local
// writes via the engine event stream (no factory; read-only view).
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
            // Observing must not count as a use: skip the access-time bump.
            engine
                .get<T>(key, { updateAccessTime: false })
                .then((v) => {
                    if (active) setSnapshot(v ?? undefined);
                })
                .catch(() => undefined);
        };
        read();

        const relevant: CacheEvent[] = ["set", "delete", "clear", "sync", "expire", "evict"];
        const listener = (data: { key?: string }): void => {
            if (data.key === undefined || data.key === key) read();
        };
        for (const e of relevant) engine.on(e, listener);

        return () => {
            active = false;
            for (const e of relevant) engine.off(e, listener);
        };
    }, [engine, key]);

    return snapshot;
}

// ------------------------------
// useCacheStats — live stats snapshot via useSyncExternalStore.
// ------------------------------

export function useCacheStats(options?: {
    config?: CacheConfig;
    engine?: CacheEngine | null;
}): CacheStats | null {
    const engine = useCacheEngine(options?.config, options?.engine);

    // useSyncExternalStore requires getSnapshot to return a STABLE reference until the
    // store changes; engine.getStats() builds a fresh object on every call, so cache it.
    const snapshotRef = useRef<{ engine: CacheEngine; stats: CacheStats } | null>(null);

    const subscribe = useCallback(
        (onChange: () => void) => {
            if (!engine) return () => undefined;
            const events: CacheEvent[] = ["set", "get", "delete", "clear", "evict", "hit", "miss"];
            const handler = (): void => {
                snapshotRef.current = { engine, stats: engine.getStats() };
                onChange();
            };
            for (const e of events) engine.on(e, handler);
            return () => {
                for (const e of events) engine.off(e, handler);
            };
        },
        [engine]
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
