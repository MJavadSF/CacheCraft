import { CacheEngine } from "./cache-engine";
import type {
    CacheConfig,
    CacheFactory,
    CacheGetOptions,
    CacheSetOptions,
    EntryInfo,
    GetOrSetOptions,
} from "./types";

// ==============================
// Type-safe facade: declare which keys hold which values once.
//
//   type Schema = {
//     [k: `user:${string}`]: User;
//     settings: Settings;
//   };
//   const cache = createTypedCache<Schema>({ dbName: "app" });
//   const u = await cache.get("user:42");   // User | null
//   await cache.set("settings", 1);          // ✗ type error
// ==============================

type KeyOf<S> = Extract<keyof S, string>;

export interface TypedCache<S> {
    readonly engine: CacheEngine;
    get<K extends KeyOf<S>>(key: K, options?: CacheGetOptions<S[K]>): Promise<S[K] | null>;
    set<K extends KeyOf<S>>(key: K, value: S[K], options?: CacheSetOptions): Promise<void>;
    getOrSet<K extends KeyOf<S>>(
        key: K,
        factory: CacheFactory<S[K]>,
        options?: GetOrSetOptions<S[K]>
    ): Promise<S[K]>;
    peek<K extends KeyOf<S>>(key: K): Promise<S[K] | null>;
    getWithMeta<K extends KeyOf<S>>(key: K): Promise<{ value: S[K]; info: EntryInfo } | null>;
    update<K extends KeyOf<S>>(
        key: K,
        fn: (current: S[K] | null) => S[K] | undefined | Promise<S[K] | undefined>,
        options?: CacheSetOptions
    ): Promise<S[K] | undefined>;
    has<K extends KeyOf<S>>(key: K): Promise<boolean>;
    remove<K extends KeyOf<S>>(key: K): Promise<boolean>;
    touch<K extends KeyOf<S>>(key: K, ttl?: number | string | null): Promise<boolean>;
}

/** Wrap an engine (or create one) with compile-time key → value typing. Zero runtime cost. */
export function createTypedCache<S>(engineOrConfig: CacheEngine | CacheConfig = {}): TypedCache<S> {
    const engine =
        engineOrConfig instanceof CacheEngine ? engineOrConfig : new CacheEngine(engineOrConfig);
    return {
        engine,
        get: (key, options) => engine.get(key, options),
        set: (key, value, options) => engine.set(key, value, options),
        getOrSet: (key, factory, options) => engine.getOrSet(key, factory, options),
        peek: (key) => engine.peek(key),
        getWithMeta: (key) => engine.getWithMeta(key),
        update: (key, fn, options) => engine.update(key, fn, options),
        has: (key) => engine.has(key),
        remove: (key) => engine.remove(key),
        touch: (key, ttl) => engine.touch(key, ttl),
    } as TypedCache<S>;
}
