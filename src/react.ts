"use client";

// ==============================
// CacheCraft React Adapter — v0.4
//
// Optional entry point: `import { useCache } from "cache-craft-engine/react"`.
// SSR-safe — every browser-only effect is guarded so it is inert on the server.
// Requires React 18+ (uses useSyncExternalStore).
// ==============================

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import { CacheEngine } from "./cache-engine";
import type { CacheConfig, GetOrSetOptions, CacheEvent } from "./types";
import { isSSR } from "./utils";

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
// useCacheEngine — stable engine reference for a component tree.
// ------------------------------

export function useCacheEngine(config?: CacheConfig): CacheEngine | null {
    const ref = useRef<CacheEngine | null>(null);
    if (ref.current === null && !isSSR()) {
        ref.current = getSharedCache(config);
    }
    return ref.current;
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

export function useCache<T>(
    key: string | null,
    factory: () => Promise<T> | T,
    options?: UseCacheOptions<T>
): UseCacheState<T> {
    const engine = options?.engine ?? useCacheEngine(options?.config);
    const enabled = (options?.enabled ?? true) && key !== null;

    const [data, setData] = useState<T | undefined>(undefined);
    const [error, setError] = useState<Error | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(enabled);
    const [isValidating, setIsValidating] = useState<boolean>(false);

    // Keep the latest factory without retriggering the effect on each render.
    const factoryRef = useRef(factory);
    factoryRef.current = factory;

    const load = useCallback(
        async (force = false) => {
            if (!engine || key === null) return;
            setIsValidating(true);
            try {
                if (force) await engine.remove(key);
                const value = await engine.getOrSet<T>(key, () => factoryRef.current(), options);
                setData(value);
                setError(null);
            } catch (err) {
                setError(err as Error);
            } finally {
                setIsLoading(false);
                setIsValidating(false);
            }
        },
        // options intentionally excluded — captured by ref-free getOrSet usage
        [engine, key]
    );

    useEffect(() => {
        if (!enabled) { setIsLoading(false); return; }
        void load();
    }, [enabled, load]);

    // Revalidate on focus.
    useEffect(() => {
        if (!options?.revalidateOnFocus || isSSR() || !enabled) return;
        const handler = () => void load();
        window.addEventListener("focus", handler);
        return () => window.removeEventListener("focus", handler);
    }, [options?.revalidateOnFocus, enabled, load]);

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
            await engine.set(key, value, options);
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
    const engine = options?.engine ?? useCacheEngine(options?.config);
    const [snapshot, setSnapshot] = useState<T | undefined>(undefined);

    useEffect(() => {
        if (!engine || key === null) return;
        let active = true;

        const read = () => {
            engine.get<T>(key).then((v) => { if (active) setSnapshot(v ?? undefined); }).catch(() => undefined);
        };
        read();

        const relevant: CacheEvent[] = ["set", "delete", "clear", "sync", "expire", "evict"];
        const listener = (data: { key?: string }) => {
            if (data.key === undefined || data.key === key) read();
        };
        relevant.forEach((e) => engine.on(e, listener));

        return () => {
            active = false;
            relevant.forEach((e) => engine.off(e, listener));
        };
    }, [engine, key]);

    return snapshot;
}

// ------------------------------
// useCacheStats — live stats snapshot via useSyncExternalStore.
// ------------------------------

export function useCacheStats(options?: { config?: CacheConfig; engine?: CacheEngine | null }) {
    const engine = options?.engine ?? useCacheEngine(options?.config);

    const subscribe = useCallback(
        (onChange: () => void) => {
            if (!engine) return () => undefined;
            const events: CacheEvent[] = ["set", "get", "delete", "clear", "evict", "hit", "miss"];
            events.forEach((e) => engine.on(e, onChange));
            return () => events.forEach((e) => engine.off(e, onChange));
        },
        [engine]
    );

    const getSnapshot = useCallback(() => (engine ? engine.getStats() : null), [engine]);
    const getServerSnapshot = useCallback(() => null, []);

    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
