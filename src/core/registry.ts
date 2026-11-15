import type { CacheEngine } from "../cache-engine";

// ==============================
// Live engine registry — lets the devtools discover every cache on the page.
// Lives on globalThis so duplicated bundles (micro-frontends) share it.
// ==============================

type Registry = {
    engines: Set<CacheEngine>;
    listeners: Set<() => void>;
};

const KEY = "__CACHECRAFT_REGISTRY__";

function registry(): Registry {
    const g = globalThis as unknown as Record<string, Registry | undefined>;
    let reg = g[KEY];
    if (!reg) {
        reg = { engines: new Set(), listeners: new Set() };
        g[KEY] = reg;
    }
    return reg;
}

function notify(): void {
    for (const listener of registry().listeners) {
        try {
            listener();
        } catch {
            /* ignore */
        }
    }
}

export function registerEngine(engine: CacheEngine): void {
    registry().engines.add(engine);
    notify();
}

export function unregisterEngine(engine: CacheEngine): void {
    if (registry().engines.delete(engine)) notify();
}

/** Every live (not destroyed) engine created with `devtools !== false`. */
export function getRegisteredEngines(): CacheEngine[] {
    return [...registry().engines];
}

/** Subscribe to engines being created/destroyed. Returns an unsubscribe function. */
export function onRegistryChange(listener: () => void): () => void {
    registry().listeners.add(listener);
    return () => registry().listeners.delete(listener);
}
