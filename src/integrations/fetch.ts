import type { CacheEngine } from "../cache-engine";
import { optionalDuration } from "../duration";
import { TimeoutError } from "../errors";
import type { Duration } from "../types";

// ==============================
// cachedFetch — fetch() backed by CacheCraft, with HTTP caching semantics.
//
//   const res = await cachedFetch(cache, "/api/products");                 // "http"
//   const res = await cachedFetch(cache, url, init, { strategy: "stale-while-revalidate", ttl: "5m" });
//
// • "http" (default) honours Cache-Control (max-age, no-store, no-cache), Expires,
//   ETag / Last-Modified (conditional requests, 304 refreshes the entry).
// • Concurrent requests for the same key share one network request.
// • Only GET/HEAD are cached. Bodies are buffered (needed to store them).
// • Responses carry `x-cachecraft-cache: HIT | MISS | STALE | REVALIDATED | BYPASS`.
// ==============================

export type FetchStrategy =
    | "http"
    | "cache-first"
    | "network-first"
    | "stale-while-revalidate"
    | "cache-only"
    | "network-only";

export type CachedFetchOptions = {
    strategy?: FetchStrategy;
    /** Fixed TTL; overrides the response's caching headers. */
    ttl?: Duration;
    /** Cache key (default: `fetch:<METHOD>:<url>` plus `varyHeaders`). */
    key?: string | ((request: Request) => string);
    /** Request headers whose values are part of the key (e.g. `["accept-language"]`). */
    varyHeaders?: string[];
    /** Which responses may be stored. Default: `response.ok`. */
    cacheable?: (response: Response) => boolean;
    /** network-first: fall back to the cache after this long. */
    networkTimeout?: Duration;
    tags?: readonly string[];
    encrypt?: boolean;
    priority?: number;
    /** Custom fetch implementation (default: global `fetch`). */
    fetch?: typeof fetch;
};

type StoredResponse = {
    url: string;
    status: number;
    statusText: string;
    headers: Array<[string, string]>;
    body: Uint8Array | null;
    storedAt: number;
};

type CacheStatus = "HIT" | "MISS" | "STALE" | "REVALIDATED" | "BYPASS";

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function toResponse(stored: StoredResponse, status: CacheStatus): Response {
    const headers = new Headers(stored.headers);
    headers.set("x-cachecraft-cache", status);
    const body = NULL_BODY.has(stored.status)
        ? null
        : (stored.body as Uint8Array<ArrayBuffer> | null);
    const response = new Response(body, {
        status: stored.status,
        statusText: stored.statusText,
        headers,
    });
    try {
        Object.defineProperty(response, "url", { value: stored.url });
    } catch {
        /* read-only in some runtimes */
    }
    return response;
}

async function toStored(response: Response): Promise<StoredResponse> {
    const body = NULL_BODY.has(response.status)
        ? null
        : new Uint8Array(await response.arrayBuffer());
    const headers: Array<[string, string]> = [];
    response.headers.forEach((value, name) => {
        headers.push([name, value]);
    });
    return {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        headers,
        body,
        storedAt: Date.now(),
    };
}

function header(stored: StoredResponse, name: string): string | undefined {
    return stored.headers.find(([n]) => n.toLowerCase() === name)?.[1];
}

function directives(cacheControl: string | undefined): Map<string, string | true> {
    const out = new Map<string, string | true>();
    for (const part of (cacheControl ?? "").split(",")) {
        const [name, value] = part.trim().split("=");
        if (name) out.set(name.toLowerCase(), value?.replace(/^"|"$/g, "") ?? true);
    }
    return out;
}

/** Freshness lifetime from the headers, or `undefined` when the response must not be stored. */
export function freshnessFromHeaders(stored: StoredResponse, now = Date.now()): number | undefined {
    const cc = directives(header(stored, "cache-control"));
    if (cc.has("no-store")) return undefined;
    const validators =
        header(stored, "etag") !== undefined || header(stored, "last-modified") !== undefined;
    if (cc.has("no-cache")) return validators ? 0 : undefined;
    const maxAge = cc.get("max-age");
    if (typeof maxAge === "string" && /^\d+$/.test(maxAge)) return Number(maxAge) * 1000;
    const expires = header(stored, "expires");
    if (expires !== undefined) {
        const at = Date.parse(expires);
        const date = Date.parse(header(stored, "date") ?? "") || now;
        return Number.isNaN(at) ? 0 : Math.max(at - date, 0);
    }
    const lastModified = Date.parse(header(stored, "last-modified") ?? "");
    if (!Number.isNaN(lastModified)) {
        // Heuristic freshness (RFC 9111 §4.2.2): 10 % of the age, at most a day.
        return Math.min(Math.max(now - lastModified, 0) * 0.1, 86_400_000);
    }
    return validators ? 0 : undefined;
}

const inflight = new WeakMap<CacheEngine, Map<string, Promise<StoredResponse>>>();

function keyFor(request: Request, options: CachedFetchOptions): string {
    if (typeof options.key === "function") return options.key(request);
    if (typeof options.key === "string") return options.key;
    let key = `fetch:${request.method}:${request.url}`;
    for (const name of options.varyHeaders ?? []) {
        key += `|${name.toLowerCase()}=${request.headers.get(name) ?? ""}`;
    }
    return key;
}

async function withTimeout<T>(promise: Promise<T>, ms: number | undefined): Promise<T> {
    if (ms === undefined) return promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`Network timed out after ${ms}ms`)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/** Fetch through the cache. Throws like `fetch` on network errors with nothing cached. */
export async function cachedFetch(
    engine: CacheEngine,
    input: RequestInfo | URL,
    init?: RequestInit,
    options: CachedFetchOptions = {}
): Promise<Response> {
    const request = new Request(input, init);
    const doFetch = options.fetch ?? fetch;
    const strategy = options.strategy ?? "http";
    const cacheableMethod = request.method === "GET" || request.method === "HEAD";

    if (!cacheableMethod || strategy === "network-only") {
        const response = await doFetch(request);
        if (!cacheableMethod) return response;
        const stored = await toStored(response);
        await store(engine, keyFor(request, options), stored, options);
        return toResponse(stored, "MISS");
    }

    const key = keyFor(request, options);
    const cached = await engine
        .getWithMeta<StoredResponse>(key, { allowStale: true })
        .catch(() => null);
    const fresh = cached !== null && !cached.info.stale;

    const network = (conditional: StoredResponse | undefined): Promise<StoredResponse> => {
        let pending = inflight.get(engine);
        if (!pending) {
            pending = new Map();
            inflight.set(engine, pending);
        }
        const existing = pending.get(key);
        if (existing) return existing;
        const promise = (async () => {
            const req = request.clone();
            const headers = new Headers(req.headers);
            const etag = conditional && header(conditional, "etag");
            const lastModified = conditional && header(conditional, "last-modified");
            if (etag) headers.set("if-none-match", etag);
            if (lastModified) headers.set("if-modified-since", lastModified);
            const response = await doFetch(new Request(req, { headers }));
            if (response.status === 304 && conditional) {
                // Not modified: refresh headers/lifetime of the cached copy.
                const refreshed: StoredResponse = { ...conditional, storedAt: Date.now() };
                const updates = await toStored(response);
                for (const name of ["cache-control", "expires", "date", "etag", "last-modified"]) {
                    const value = header(updates, name);
                    if (value !== undefined) {
                        refreshed.headers = refreshed.headers.filter(
                            ([n]) => n.toLowerCase() !== name
                        );
                        refreshed.headers.push([name, value]);
                    }
                }
                await store(engine, key, refreshed, options);
                return Object.assign(refreshed, { revalidated: true });
            }
            const stored = await toStored(response);
            const storable = options.cacheable ? options.cacheable(response) : response.ok;
            if (storable) await store(engine, key, stored, options);
            return stored;
        })().finally(() => pending?.delete(key));
        pending.set(key, promise);
        return promise;
    };

    const fromNetwork = async (conditional?: StoredResponse): Promise<Response> => {
        const stored = await network(conditional);
        const revalidated = (stored as { revalidated?: boolean }).revalidated === true;
        return toResponse(stored, revalidated ? "REVALIDATED" : "MISS");
    };

    switch (strategy) {
        case "cache-only":
            if (cached && fresh) return toResponse(cached.value, "HIT");
            return new Response(null, { status: 504, statusText: "Gateway Timeout (cache-only)" });

        case "stale-while-revalidate":
            if (cached) {
                // Background refresh; a failure keeps serving the stale copy.
                if (!fresh) network(cached.value).catch(() => undefined);
                return toResponse(cached.value, fresh ? "HIT" : "STALE");
            }
            return fromNetwork();

        case "network-first":
            try {
                return await withTimeout(
                    fromNetwork(cached?.value),
                    optionalDuration(options.networkTimeout)
                );
            } catch (error) {
                if (cached) return toResponse(cached.value, cached.info.stale ? "STALE" : "HIT");
                throw error;
            }

        case "cache-first":
            if (cached && fresh) return toResponse(cached.value, "HIT");
            try {
                return await fromNetwork(cached?.value);
            } catch (error) {
                if (cached) return toResponse(cached.value, "STALE");
                throw error;
            }

        default: {
            // "http"
            if (cached && fresh) return toResponse(cached.value, "HIT");
            try {
                return await fromNetwork(cached?.value);
            } catch (error) {
                const cc = cached ? directives(header(cached.value, "cache-control")) : undefined;
                if (cached && !cc?.has("must-revalidate")) return toResponse(cached.value, "STALE");
                throw error;
            }
        }
    }
}

async function store(
    engine: CacheEngine,
    key: string,
    stored: StoredResponse,
    options: CachedFetchOptions
): Promise<void> {
    const explicit = optionalDuration(options.ttl);
    const ttl = explicit ?? freshnessFromHeaders(stored);
    if (ttl === undefined) return; // no-store, or nothing to revalidate with
    await engine
        .set(key, stored, {
            ttl,
            ...(options.tags ? { tags: options.tags } : {}),
            ...(options.encrypt ? { encrypt: true } : {}),
            ...(options.priority !== undefined ? { priority: options.priority } : {}),
            // Bodies are usually already compressed (gzip/br on the wire, images).
            compress: false,
        })
        .catch(() => undefined); // caching is best-effort; the response is still returned
}

/**
 * A request handler for Service Workers and Workbox routes:
 *
 *   self.addEventListener("fetch", (e) => e.respondWith(handler({ request: e.request })));
 *   registerRoute(({ url }) => url.pathname.startsWith("/api/"), handler);   // Workbox
 */
export function createFetchHandler(
    engine: CacheEngine,
    options: CachedFetchOptions = {}
): (context: { request: Request }) => Promise<Response> {
    return ({ request }) => cachedFetch(engine, request, undefined, options);
}
