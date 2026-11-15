import { base64ToBytes, bytesToBase64 } from "../base64";
import { CacheError, QuotaExceededError, UnsupportedEnvironmentError } from "../errors";
import { isExpired } from "../time";
import type {
    StorageAdapter,
    StoredMeta,
    StoredPayload,
    StoredRecord,
    WriteOp,
    WriteResult,
} from "./types";

// ==============================
// Web Storage adapter (localStorage / sessionStorage)
//
// Small, synchronous storage (≈5 MB per origin). Writes are applied with an
// undo log, so a quota failure half-way through a batch leaves nothing behind.
// Binary payloads are stored as Base64.
// ==============================

export type WebStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function isQuotaError(error: unknown): boolean {
    const name = (error as { name?: string } | null)?.name;
    return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function encodePayload(payload: StoredPayload): string {
    return typeof payload === "string" ? `s${payload}` : `b${bytesToBase64(payload)}`;
}

function decodePayload(text: string): StoredPayload {
    return text.startsWith("b") ? base64ToBytes(text.slice(1)) : text.slice(1);
}

export class WebStorageAdapter implements StorageAdapter {
    readonly kind: string;
    readonly persistent: boolean;
    private readonly prefix: string;

    constructor(
        private readonly storage: WebStorageLike,
        readonly dbName = "cache-db",
        readonly storeName = "cache",
        kind = "webStorage"
    ) {
        this.kind = kind;
        this.persistent = kind !== "sessionStorage";
        this.prefix = `cc:${dbName}:${storeName}:`;
    }

    /** `localStorage` / `sessionStorage`, or throws in environments without it. */
    static from(
        which: "localStorage" | "sessionStorage",
        dbName?: string,
        storeName?: string
    ): WebStorageAdapter {
        let storage: WebStorageLike | undefined;
        try {
            storage = (globalThis as unknown as Record<string, WebStorageLike | undefined>)[which];
        } catch {
            storage = undefined; // access can throw (sandboxed iframes, disabled cookies)
        }
        if (!storage) {
            throw new UnsupportedEnvironmentError(`${which} is not available in this environment`);
        }
        return new WebStorageAdapter(storage, dbName, storeName, which);
    }

    private id(kind: "m" | "d", namespace: string, key: string): string {
        return `${this.prefix}${kind}:${JSON.stringify([namespace, key])}`;
    }

    private readMeta(namespace: string, key: string): StoredMeta | undefined {
        const raw = this.storage.getItem(this.id("m", namespace, key));
        return raw === null ? undefined : (JSON.parse(raw) as StoredMeta);
    }

    async loadMeta(namespace: string): Promise<Array<[string, StoredMeta]>> {
        const head = `${this.prefix}m:`;
        const out: Array<[string, StoredMeta]> = [];
        for (let i = 0; i < this.storage.length; i++) {
            const id = this.storage.key(i);
            if (!id?.startsWith(head)) continue;
            const [ns, key] = JSON.parse(id.slice(head.length)) as [string, string];
            if (ns !== namespace) continue;
            const raw = this.storage.getItem(id);
            if (raw !== null) out.push([key, JSON.parse(raw) as StoredMeta]);
        }
        return out;
    }

    async getMeta(namespace: string, keys: readonly string[]): Promise<Map<string, StoredMeta>> {
        const out = new Map<string, StoredMeta>();
        for (const key of keys) {
            const meta = this.readMeta(namespace, key);
            if (meta) out.set(key, meta);
        }
        return out;
    }

    async get(namespace: string, keys: readonly string[]): Promise<Map<string, StoredRecord>> {
        const out = new Map<string, StoredRecord>();
        for (const key of keys) {
            const meta = this.readMeta(namespace, key);
            const payload = this.storage.getItem(this.id("d", namespace, key));
            if (meta && payload !== null) out.set(key, { meta, payload: decodePayload(payload) });
        }
        return out;
    }

    async write(namespace: string, ops: readonly WriteOp[]): Promise<WriteResult> {
        const result: WriteResult = { deleted: [] };
        const undo: Array<[string, string | null]> = [];
        const set = (id: string, value: string | null): void => {
            undo.push([id, this.storage.getItem(id)]);
            if (value === null) this.storage.removeItem(id);
            else this.storage.setItem(id, value);
        };
        try {
            for (const op of ops) {
                const m = this.id("m", namespace, op.key);
                const d = this.id("d", namespace, op.key);
                switch (op.type) {
                    case "put":
                        set(d, encodePayload(op.payload));
                        set(m, JSON.stringify(op.meta));
                        break;
                    case "delete":
                        if (this.storage.getItem(m) !== null) result.deleted.push(op.key);
                        set(d, null);
                        set(m, null);
                        break;
                    case "deleteIfExpired": {
                        const meta = this.readMeta(namespace, op.key);
                        if (meta && isExpired(meta.expiresAt, op.now)) {
                            set(d, null);
                            set(m, null);
                            result.deleted.push(op.key);
                        }
                        break;
                    }
                    case "touch": {
                        const meta = this.readMeta(namespace, op.key);
                        if (!meta) break;
                        if (op.lastAccessed !== undefined) {
                            meta.lastAccessed = Math.max(meta.lastAccessed, op.lastAccessed);
                        }
                        if (op.accessDelta) meta.accessCount += op.accessDelta;
                        if (op.expiresAt === null) delete meta.expiresAt;
                        else if (op.expiresAt !== undefined) meta.expiresAt = op.expiresAt;
                        set(m, JSON.stringify(meta));
                        break;
                    }
                }
            }
        } catch (error) {
            for (const [id, previous] of undo.reverse()) {
                try {
                    if (previous === null) this.storage.removeItem(id);
                    else this.storage.setItem(id, previous);
                } catch {
                    /* best effort */
                }
            }
            if (isQuotaError(error)) throw new QuotaExceededError(undefined, error as Error);
            throw new CacheError((error as Error).message, "TX_FAILED", error as Error);
        }
        return result;
    }

    async clear(namespace: string): Promise<void> {
        const heads = [`${this.prefix}m:`, `${this.prefix}d:`];
        const doomed: string[] = [];
        for (let i = 0; i < this.storage.length; i++) {
            const id = this.storage.key(i);
            const head = id ? heads.find((h) => id.startsWith(h)) : undefined;
            if (!id || !head) continue;
            const [ns] = JSON.parse(id.slice(head.length)) as [string, string];
            if (ns === namespace) doomed.push(id);
        }
        for (const id of doomed) this.storage.removeItem(id);
    }

    async getSystem(key: string): Promise<unknown> {
        const raw = this.storage.getItem(`${this.prefix}sys:${key}`);
        return raw === null ? undefined : JSON.parse(raw);
    }

    async initSystem(key: string, create: () => unknown): Promise<unknown> {
        const id = `${this.prefix}sys:${key}`;
        const raw = this.storage.getItem(id);
        if (raw !== null) return JSON.parse(raw);
        const value = create();
        this.storage.setItem(id, JSON.stringify(value));
        return value;
    }

    close(): void {
        /* nothing to release */
    }
}
