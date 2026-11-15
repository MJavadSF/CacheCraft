import type { CacheEntryMeta } from "../types";

// ==============================
// Storage adapter contract
//
// The engine talks to storage only through this interface. One adapter instance
// serves one (dbName, storeName) pair; every call is scoped to a namespace, and a
// namespace can never read, list or modify another namespace's records.
// ==============================

/** Persisted metadata of a record (everything but the payload). */
export type StoredMeta = Omit<CacheEntryMeta, "key">;

export type StoredPayload = string | Uint8Array;

export type StoredRecord = {
    meta: StoredMeta;
    payload: StoredPayload;
};

export type WriteOp =
    /** Insert or replace a record (payload + metadata). */
    | { type: "put"; key: string; meta: StoredMeta; payload: StoredPayload }
    /**
     * Merge access metadata into an existing record (no-op when it is gone).
     * `accessDelta` is added to the stored count so concurrent tabs don't lose reads;
     * `expiresAt: null` removes the expiry, `undefined` leaves it unchanged.
     */
    | {
          type: "touch";
          key: string;
          lastAccessed?: number | undefined;
          accessDelta?: number | undefined;
          expiresAt?: number | null | undefined;
      }
    | { type: "delete"; key: string }
    /** Delete only if the *stored* record is (still) expired at `now`. */
    | { type: "deleteIfExpired"; key: string; now: number };

export type WriteResult = {
    /** Keys removed by `delete` (that existed) and `deleteIfExpired`. */
    deleted: string[];
};

export interface StorageAdapter {
    /** Short identifier, e.g. `"indexeddb"`, `"memory"`. */
    readonly kind: string;
    /** Whether data survives a reload. */
    readonly persistent: boolean;

    /** Metadata of every record in a namespace (used once to build the index). */
    loadMeta(namespace: string): Promise<Array<[string, StoredMeta]>>;
    /** Metadata of some records (missing keys are absent from the map). */
    getMeta(namespace: string, keys: readonly string[]): Promise<Map<string, StoredMeta>>;
    /** Full records (missing keys are absent from the map). */
    get(namespace: string, keys: readonly string[]): Promise<Map<string, StoredRecord>>;
    /** Apply all operations atomically. */
    write(namespace: string, ops: readonly WriteOp[]): Promise<WriteResult>;
    /** Remove every record of a namespace. */
    clear(namespace: string): Promise<void>;

    /** Read a database-wide system value (e.g. the KDF salt). */
    getSystem(key: string): Promise<unknown>;
    /** Atomically read a system value, creating it with `create()` if absent. */
    initSystem(key: string, create: () => unknown): Promise<unknown>;

    /**
     * Optional: move one record written by CacheCraft ≤0.5 into this layout, in a
     * single atomic step. `convert` maps the legacy value; `undefined` drops it.
     */
    migrateLegacy?(
        namespace: string,
        key: string,
        convert: (legacy: unknown) => StoredRecord | undefined
    ): Promise<StoredRecord | undefined>;
    /** Optional: keys of all ≤0.5 records (namespace-prefixed strings). */
    legacyKeys?(): Promise<string[]>;
    /** Optional: whether any ≤0.5 data is left. */
    hasLegacy?(): Promise<boolean>;
    /** Optional: delete all ≤0.5 data. Returns how many records were removed. */
    dropLegacy?(): Promise<number>;

    /** Release connections / handles. The adapter may be reopened by a later call. */
    close(): void;
}

export type StorageFactoryContext = {
    dbName: string;
    storeName: string;
};

export type StorageFactory = (context: StorageFactoryContext) => StorageAdapter;
