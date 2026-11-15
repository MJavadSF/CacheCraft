import type { CacheEngine } from "../cache-engine";
import type { Duration } from "../types";

// ==============================
// TanStack Query persistence
//
//   import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
//   const persister = createCacheCraftPersister(cache, { maxAge: "24h" });
//   <PersistQueryClientProvider client={queryClient} persistOptions={{ persister }}>
//
// or per-query with `experimental_createQueryPersister({ storage: createCacheCraftStorage(cache) })`.
// Structurally typed — no dependency on @tanstack/*.
// ==============================

export type PersistedClient = {
    timestamp: number;
    buster: string;
    clientState: unknown;
};

export interface Persister {
    persistClient(client: PersistedClient): Promise<void> | void;
    restoreClient(): Promise<PersistedClient | undefined> | PersistedClient | undefined;
    removeClient(): Promise<void> | void;
}

export type CacheCraftPersisterOptions = {
    /** Cache key of the dehydrated client. Default: `"tanstack-query:client"`. */
    key?: string;
    /** Drop the persisted client after this long. Default: never (TanStack applies its own maxAge). */
    maxAge?: Duration;
    /** Coalesce writes: persist at most once per this many ms. Default: 1000. */
    throttleTime?: number;
    /** Encrypt the persisted state. */
    encrypt?: boolean;
};

export function createCacheCraftPersister(
    engine: CacheEngine,
    options: CacheCraftPersisterOptions = {}
): Persister & { flush(): Promise<void> } {
    const key = options.key ?? "tanstack-query:client";
    const throttle = options.throttleTime ?? 1000;
    let latest: PersistedClient | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let writing: Promise<void> = Promise.resolve();

    const flush = async (): Promise<void> => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        const client = latest;
        latest = null;
        if (!client) return writing;
        writing = writing
            .then(() =>
                engine.set(key, client, {
                    ...(options.maxAge !== undefined ? { ttl: options.maxAge } : {}),
                    ...(options.encrypt ? { encrypt: true } : {}),
                    tags: ["tanstack-query"],
                })
            )
            .catch(() => undefined);
        return writing;
    };

    return {
        persistClient(client) {
            latest = client;
            if (throttle <= 0) return flush();
            if (timer === null) timer = setTimeout(() => void flush(), throttle);
        },
        async restoreClient() {
            await writing;
            return (await engine.get<PersistedClient>(key)) ?? undefined;
        },
        async removeClient() {
            latest = null;
            if (timer !== null) clearTimeout(timer);
            timer = null;
            await writing;
            await engine.remove(key);
        },
        flush,
    };
}

/** An AsyncStorage for `experimental_createQueryPersister` (and similar APIs). */
export function createCacheCraftStorage<T = unknown>(
    engine: CacheEngine,
    options: { maxAge?: Duration; encrypt?: boolean; prefix?: string } = {}
): {
    getItem(key: string): Promise<T | undefined>;
    setItem(key: string, value: T): Promise<void>;
    removeItem(key: string): Promise<void>;
    entries(): Promise<Array<[string, T]>>;
} {
    const prefix = options.prefix ?? "tanstack-query:";
    return {
        async getItem(key) {
            return (await engine.get<T>(prefix + key)) ?? undefined;
        },
        async setItem(key, value) {
            await engine.set(prefix + key, value, {
                ...(options.maxAge !== undefined ? { ttl: options.maxAge } : {}),
                ...(options.encrypt ? { encrypt: true } : {}),
                tags: ["tanstack-query"],
            });
        },
        async removeItem(key) {
            await engine.remove(prefix + key);
        },
        async entries() {
            const results = await engine.query<T>({ pattern: prefix });
            return results
                .filter((r) => r.key.startsWith(prefix))
                .map((r): [string, T] => [r.key.slice(prefix.length), r.value]);
        },
    };
}
