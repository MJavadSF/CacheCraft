// ==============================
// CacheCraft for Vue 3.3+ — `import { useCache } from "cache-craft-engine/vue"`
//
//   // main.ts
//   app.provide(CacheEngineKey, createClientCache({ dbName: "app" }));
//   // or, inside setup():  provideCache(engine)
//
//   const { data, error, isLoading, refresh } = useCache(
//       () => `user:${props.id}`, () => api.user(props.id), { ttl: "5m" });
// ==============================

import {
    hasInjectionContext,
    type InjectionKey,
    inject,
    type MaybeRefOrGetter,
    onScopeDispose,
    provide,
    type Ref,
    type ShallowRef,
    shallowRef,
    toValue,
    watch,
} from "vue";
import type { CacheEngine } from "../cache-engine";
import type {
    CacheEventData,
    CacheFactory,
    CacheSetOptions,
    CacheStats,
    GetOrSetOptions,
} from "../types";
import { toError } from "../utils";

export const CacheEngineKey: InjectionKey<CacheEngine | null> = Symbol("cachecraft-engine");

/** Provide an engine to every `useCache*` below this component. */
export function provideCache(engine: CacheEngine | null): void {
    provide(CacheEngineKey, engine);
}

function resolveEngine(explicit: CacheEngine | null | undefined): CacheEngine | null {
    if (explicit !== undefined) return explicit;
    return hasInjectionContext() ? inject(CacheEngineKey, null) : null;
}

export type UseCacheOptions<T> = GetOrSetOptions<T> & {
    engine?: CacheEngine | null;
    enabled?: MaybeRefOrGetter<boolean>;
    revalidateOnFocus?: boolean;
    revalidateOnReconnect?: boolean;
    /** Revalidate every N ms while the tab is visible. */
    refreshInterval?: number;
    fallbackData?: T;
    keepPreviousData?: boolean;
};

export type UseCacheReturn<T> = {
    data: ShallowRef<T | undefined>;
    error: Ref<Error | null>;
    isLoading: Ref<boolean>;
    isValidating: Ref<boolean>;
    refresh: () => Promise<void>;
    invalidate: () => Promise<void>;
    mutate: (
        value: T | ((current: T | undefined) => T),
        options?: { rollbackOnError?: boolean }
    ) => Promise<void>;
};

const HOOK_KEYS = [
    "engine",
    "enabled",
    "revalidateOnFocus",
    "revalidateOnReconnect",
    "refreshInterval",
    "fallbackData",
    "keepPreviousData",
] as const;

function cacheOptions<T>(options: UseCacheOptions<T> | undefined): GetOrSetOptions<T> {
    const out: Record<string, unknown> = { ...options };
    for (const k of HOOK_KEYS) delete out[k];
    return out as GetOrSetOptions<T>;
}

export function useCache<T>(
    key: MaybeRefOrGetter<string | null>,
    factory: CacheFactory<T>,
    options?: UseCacheOptions<T>
): UseCacheReturn<T> {
    const engine = resolveEngine(options?.engine);
    const data = shallowRef<T | undefined>(options?.fallbackData);
    const error = shallowRef<Error | null>(null);
    const isLoading = shallowRef(false);
    const isValidating = shallowRef(false);
    let request = 0;
    let currentKey: string | null = null;

    const load = async (force = false): Promise<void> => {
        const k = currentKey;
        if (!engine || k === null) return;
        const id = ++request;
        isValidating.value = true;
        try {
            const opts = cacheOptions(options);
            const value = await engine.getOrSet<T>(k, factory, {
                ...opts,
                forceRefresh: force || opts.forceRefresh,
            });
            if (id !== request) return;
            data.value = value;
            error.value = null;
        } catch (err) {
            if (id === request) error.value = toError(err);
        } finally {
            if (id === request) {
                isLoading.value = false;
                isValidating.value = false;
            }
        }
    };

    watch(
        () => [toValue(key), toValue(options?.enabled ?? true)] as const,
        ([k, enabled], _old, onCleanup) => {
            currentKey = enabled ? k : null;
            if (!options?.keepPreviousData) data.value = options?.fallbackData;
            error.value = null;
            request++;
            if (!engine || currentKey === null) {
                isLoading.value = false;
                isValidating.value = false;
                return;
            }
            isLoading.value = data.value === undefined;
            void load();
            const watched = currentKey;
            const offs = [
                engine.on("set", (e: CacheEventData) => {
                    if (e.key === watched && e.value !== undefined) data.value = e.value as T;
                }),
                engine.on("sync", (e: CacheEventData) => {
                    if (e.key === undefined || e.key === watched) {
                        void engine.peek<T>(watched).then((v) => {
                            if (v !== null) data.value = v;
                        });
                    }
                }),
                engine.on("delete", (e: CacheEventData) => {
                    if (e.key === watched) void load();
                }),
                engine.on("clear", () => void load()),
            ];
            onCleanup(() => {
                for (const off of offs) off();
            });
        },
        { immediate: true }
    );

    if (typeof window !== "undefined") {
        const cleanups: Array<() => void> = [];
        if (options?.revalidateOnFocus) {
            const onVisible = (): void => {
                if (document.visibilityState === "visible") void load();
            };
            document.addEventListener("visibilitychange", onVisible);
            cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));
        }
        if (options?.revalidateOnReconnect) {
            const onOnline = (): void => void load(true);
            window.addEventListener("online", onOnline);
            cleanups.push(() => window.removeEventListener("online", onOnline));
        }
        if (options?.refreshInterval) {
            const id = setInterval(() => {
                if (document.visibilityState !== "hidden") void load(true);
            }, options.refreshInterval);
            cleanups.push(() => clearInterval(id));
        }
        onScopeDispose(() => {
            request++;
            for (const c of cleanups) c();
        }, true);
    }

    return {
        data,
        error,
        isLoading,
        isValidating,
        refresh: () => load(true),
        invalidate: async () => {
            if (engine && currentKey !== null) await engine.remove(currentKey);
        },
        mutate: async (value, mutateOptions) => {
            if (!engine || currentKey === null) return;
            const previous = data.value;
            const next =
                typeof value === "function" ? (value as (c: T | undefined) => T)(previous) : value;
            data.value = next;
            try {
                await engine.set(currentKey, next, cacheOptions(options) as CacheSetOptions);
            } catch (err) {
                if (mutateOptions?.rollbackOnError ?? true) data.value = previous;
                error.value = toError(err);
                throw err;
            }
        },
    };
}

/** Read-only, live view of one key. */
export function useCacheValue<T>(
    key: MaybeRefOrGetter<string | null>,
    options?: { engine?: CacheEngine | null }
): ShallowRef<T | undefined> {
    const engine = resolveEngine(options?.engine);
    const value = shallowRef<T | undefined>(undefined);
    watch(
        () => toValue(key),
        (k, _old, onCleanup) => {
            value.value = undefined;
            if (!engine || k === null) return;
            let active = true;
            const read = (): void => {
                void engine
                    .peek<T>(k)
                    .then((v) => {
                        if (active) value.value = v ?? undefined;
                    })
                    .catch(() => undefined);
            };
            read();
            const offs = (["set", "delete", "clear", "sync", "expire", "evict"] as const).map(
                (ev) =>
                    engine.on(ev, (e) => {
                        const keys = (e.metadata as { keys?: string[] } | undefined)?.keys;
                        if (e.key === undefined ? !keys || keys.includes(k) : e.key === k) read();
                    })
            );
            onCleanup(() => {
                active = false;
                for (const off of offs) off();
            });
        },
        { immediate: true }
    );
    return value;
}

/** Live (throttled) stats. */
export function useCacheStats(options?: {
    engine?: CacheEngine | null;
    throttleMs?: number;
}): ShallowRef<CacheStats | null> {
    const engine = resolveEngine(options?.engine);
    const stats = shallowRef<CacheStats | null>(engine?.getStats() ?? null);
    if (!engine) return stats;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = (): void => {
        if (timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            stats.value = engine.getStats();
        }, options?.throttleMs ?? 250);
    };
    const offs = (
        ["set", "get", "delete", "clear", "evict", "hit", "miss", "sync", "expire"] as const
    ).map((e) => engine.on(e, update));
    onScopeDispose(() => {
        if (timer !== null) clearTimeout(timer);
        for (const off of offs) off();
    }, true);
    return stats;
}
