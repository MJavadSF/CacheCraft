// CacheCraft 1.0 — a tour of the new features (type-checked in CI).

import { createCache, createTypedCache, type StandardSchemaV1 } from "../src";
import { mountDevtools } from "../src/devtools";
import { cachedFetch, createFetchHandler } from "../src/integrations/fetch";

type User = { id: number; name: string; joined: Date };

export async function tour(): Promise<void> {
    const cache = createCache({
        dbName: "tour",
        maxSize: "50MB",
        maxEntries: 5_000,
        tagQuotas: { avatars: { maxSize: "10MB" } },
        defaultTTL: "1h",
        ttlJitter: 0.1,
        memoryCache: { maxEntries: 300 },
        encryptionKey: "change-me",
        crossTab: { singleFlight: true },
        label: "Tour cache",
    });

    // Rich values round-trip.
    await cache.set("user:1", { id: 1, name: "Ada", joined: new Date() } satisfies User, {
        tags: ["users"],
    });
    const user = await cache.get<User>("user:1");
    console.log(user?.joined instanceof Date); // true

    // Resilient cache-aside.
    const controller = new AbortController();
    const report = await cache.getOrSet(
        "report",
        async ({ signal, attempt }) => {
            console.log("attempt", attempt);
            const res = await fetch("/api/report", { signal });
            return res.json() as Promise<unknown>;
        },
        {
            ttl: "15m",
            retry: 2,
            timeout: "10s",
            signal: controller.signal,
            fallbackToStale: true,
            maxStale: "1d",
        }
    );
    console.log(report);

    // Small helpers.
    await cache.touch("user:1", "2h");
    await cache.update<number>("visits", (n) => (n ?? 0) + 1);
    console.log(await cache.getWithMeta("user:1"));
    await cache.invalidateByPattern(/^tmp:/);

    // Namespaces are fully isolated, and can use another backend.
    const images = cache.namespace("images", { storage: "opfs", maxSize: "200MB" });
    await images.setBlob("logo", new Blob(["<svg/>"], { type: "image/svg+xml" }), {
        tags: ["avatars"],
    });

    // Validation (any Standard Schema library works: Zod, Valibot, ArkType…).
    const IsUser: StandardSchemaV1<unknown, User> = {
        "~standard": {
            version: 1,
            vendor: "example",
            validate: (v) =>
                typeof v === "object" && v !== null && "id" in v
                    ? { value: v as User }
                    : { issues: [{ message: "not a user" }] },
        },
    };
    await cache.get("user:1", { schema: IsUser });

    // Type-safe keys.
    const typed = createTypedCache<{ [k: `user:${number}`]: User }>(cache);
    const u2: User | null = await typed.get("user:2");
    console.log(u2);

    // Encryption key rotation.
    await cache.set("token", "secret", { encrypt: true });
    await cache.rotateKey("a-new-key");

    // HTTP caching.
    const res = await cachedFetch(cache, "/api/products", undefined, {
        strategy: "stale-while-revalidate",
    });
    console.log(res.headers.get("x-cachecraft-cache"));
    const handler = createFetchHandler(cache, { strategy: "network-first", networkTimeout: "3s" });
    void handler;

    // Portable backups.
    const backup = await cache.exportBlob();
    await createCache({ dbName: "restore", encryptionKey: "a-new-key" }).importBlob(backup);

    // The management panel.
    const devtools = mountDevtools({ position: "bottom-left" });
    devtools.open();
}
