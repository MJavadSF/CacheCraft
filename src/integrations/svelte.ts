// ==============================
// CacheCraft for Svelte — stores following the Svelte store contract (works with
// `$store` syntax in Svelte 3/4/5 and in plain JS). No dependency on svelte.
//
//   const user = cacheStore(cache, `user:${id}`, () => api.user(id), { ttl: "5m" });
//   {#if $user.isLoading}…{:else}{$user.data.name}{/if}
// ==============================

import type { CacheEngine } from "../cache-engine";
import type {
    CacheEventData,
    CacheFactory,
    CacheSetOptions,
    CacheStats,
    GetOrSetOptions,
} from "../types";
import { toError } from "../utils";

export type Subscriber<T> = (value: T) => void;
export type Unsubscriber = () => void;

export interface Readable<T> {
    subscribe(run: Subscriber<T>): Unsubscriber;
}

export type CacheStoreState<T> = {
    data: T | undefined;
    error: Error | null;
    isLoading: boolean;
    isValidating: boolean;
};

export type CacheStore<T> = Readable<CacheStoreState<T>> & {
    refresh(): Promise<void>;
    invalidate(): Promise<void>;
    mutate(value: T | ((current: T | undefined) => T)): Promise<void>;
};

/** A tiny writable-like primitive implementing the store contract. */
function createState<T>(
    initial: T,
    start: () => () => void
): {
    store: Readable<T>;
    get(): T;
    set(value: T): void;
} {
    let value = initial;
    const subscribers = new Set<Subscriber<T>>();
    let stop: (() => void) | null = null;
    return {
        store: {
            subscribe(run) {
                subscribers.add(run);
                if (subscribers.size === 1) stop = start();
                run(value);
                return () => {
                    subscribers.delete(run);
                    if (subscribers.size === 0 && stop) {
                        stop();
                        stop = null;
                    }
                };
            },
        },
        get: () => value,
        set(next) {
            value = next;
            for (const run of [...subscribers]) run(value);
        },
    };
}

/** Cache-aside store: loads on first subscription, stays in sync with writes and other tabs. */
export function cacheStore<T>(
    engine: CacheEngine | null,
    key: string,
    factory: CacheFactory<T>,
    options?: GetOrSetOptions<T> & { fallbackData?: T }
): CacheStore<T> {
    let request = 0;
    const { fallbackData, ...getOrSetOptions } = options ?? {};

    const load = async (force = false): Promise<void> => {
        if (!engine) return;
        const id = ++request;
        state.set({ ...state.get(), isValidating: true });
        try {
            const value = await engine.getOrSet<T>(key, factory, {
                ...getOrSetOptions,
                forceRefresh: force || getOrSetOptions.forceRefresh,
            });
            if (id === request)
                state.set({ data: value, error: null, isLoading: false, isValidating: false });
        } catch (err) {
            if (id === request) {
                state.set({
                    ...state.get(),
                    error: toError(err),
                    isLoading: false,
                    isValidating: false,
                });
            }
        }
    };

    const state = createState<CacheStoreState<T>>(
        { data: fallbackData, error: null, isLoading: engine !== null, isValidating: false },
        () => {
            if (!engine) return () => undefined;
            void load();
            const offs = [
                engine.on("set", (e: CacheEventData) => {
                    if (e.key === key && e.value !== undefined)
                        state.set({ ...state.get(), data: e.value as T });
                }),
                engine.on("sync", (e: CacheEventData) => {
                    if (e.key === undefined || e.key === key) {
                        void engine.peek<T>(key).then((v) => {
                            if (v !== null) state.set({ ...state.get(), data: v });
                        });
                    }
                }),
                engine.on("delete", (e: CacheEventData) => {
                    if (e.key === key) void load();
                }),
                engine.on("clear", () => void load()),
            ];
            return () => {
                request++;
                for (const off of offs) off();
            };
        }
    );

    return {
        subscribe: state.store.subscribe,
        refresh: () => load(true),
        invalidate: async () => {
            await engine?.remove(key);
        },
        async mutate(value) {
            if (!engine) return;
            const previous = state.get().data;
            const next =
                typeof value === "function" ? (value as (c: T | undefined) => T)(previous) : value;
            state.set({ ...state.get(), data: next });
            try {
                await engine.set(key, next, getOrSetOptions as CacheSetOptions);
            } catch (err) {
                state.set({ ...state.get(), data: previous, error: toError(err) });
                throw err;
            }
        },
    };
}

/** Read-only live view of one key (`undefined` when missing). */
export function cacheValueStore<T>(
    engine: CacheEngine | null,
    key: string
): Readable<T | undefined> {
    const state = createState<T | undefined>(undefined, () => {
        if (!engine) return () => undefined;
        let active = true;
        const read = (): void => {
            void engine
                .peek<T>(key)
                .then((v) => {
                    if (active) state.set(v ?? undefined);
                })
                .catch(() => undefined);
        };
        read();
        const offs = (["set", "delete", "clear", "sync", "expire", "evict"] as const).map((ev) =>
            engine.on(ev, (e) => {
                const keys = (e.metadata as { keys?: string[] } | undefined)?.keys;
                if (e.key === undefined ? !keys || keys.includes(key) : e.key === key) read();
            })
        );
        return () => {
            active = false;
            for (const off of offs) off();
        };
    });
    return state.store;
}

/** Live stats (throttled). */
export function cacheStatsStore(
    engine: CacheEngine | null,
    throttleMs = 250
): Readable<CacheStats | null> {
    const state = createState<CacheStats | null>(engine?.getStats() ?? null, () => {
        if (!engine) return () => undefined;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const update = (): void => {
            if (timer !== null) return;
            timer = setTimeout(() => {
                timer = null;
                state.set(engine.getStats());
            }, throttleMs);
        };
        const offs = (
            ["set", "get", "delete", "clear", "evict", "hit", "miss", "sync", "expire"] as const
        ).map((e) => engine.on(e, update));
        return () => {
            if (timer !== null) clearTimeout(timer);
            for (const off of offs) off();
        };
    });
    return state.store;
}
