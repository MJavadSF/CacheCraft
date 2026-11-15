import { CacheError } from "../errors";
import type { StorageOption } from "../types";
import { IndexedDBAdapter } from "./indexeddb";
import { MemoryAdapter } from "./memory";
import { OPFSAdapter } from "./opfs";
import type { StorageAdapter } from "./types";
import { WebStorageAdapter } from "./web-storage";

export { hasIndexedDB, IndexedDBAdapter } from "./indexeddb";
export { MemoryAdapter } from "./memory";
export { isOPFSSupported, OPFSAdapter } from "./opfs";
export type {
    StorageAdapter,
    StorageFactory,
    StorageFactoryContext,
    StoredMeta,
    StoredPayload,
    StoredRecord,
    WriteOp,
    WriteResult,
} from "./types";
export { WebStorageAdapter, type WebStorageLike } from "./web-storage";

// ==============================
// Shared adapters: engines on the same (backend, dbName, storeName) — e.g. a
// cache and its namespaces — share one adapter (one IndexedDB connection).
// ==============================

type Shared = { adapter: StorageAdapter; refs: number };
const shared = new Map<string, Shared>();

function create(kind: string, dbName: string, storeName: string): StorageAdapter {
    switch (kind) {
        case "indexeddb":
            return new IndexedDBAdapter(dbName, storeName);
        case "memory":
            return new MemoryAdapter(dbName, storeName);
        case "localStorage":
        case "sessionStorage":
            return WebStorageAdapter.from(kind, dbName, storeName);
        case "opfs":
            return new OPFSAdapter(dbName, storeName);
        default:
            throw new CacheError(`Unknown storage "${kind}"`, "INVALID_CONFIG");
    }
}

export function acquireStorage(
    option: StorageOption,
    dbName: string,
    storeName: string
): { adapter: StorageAdapter; release: () => void } {
    if (typeof option === "function") {
        const adapter = option({ dbName, storeName });
        return { adapter, release: () => adapter.close() };
    }
    if (typeof option === "object") {
        // A user-owned instance: its lifecycle is the caller's.
        return { adapter: option, release: () => undefined };
    }
    const id = `${option}\u0000${dbName}\u0000${storeName}`;
    let entry = shared.get(id);
    if (!entry) {
        entry = { adapter: create(option, dbName, storeName), refs: 0 };
        shared.set(id, entry);
    }
    entry.refs++;
    let released = false;
    const held = entry;
    return {
        adapter: held.adapter,
        release: () => {
            if (released) return;
            released = true;
            held.refs--;
            if (held.refs <= 0 && shared.get(id) === held) {
                shared.delete(id);
                held.adapter.close();
            }
        },
    };
}
