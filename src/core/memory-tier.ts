// ==============================
// In-memory tier (L1): a small LRU of *decoded* values in front of storage.
// Map insertion order is the recency order: a hit re-inserts the key.
// ==============================

type Slot = { value: unknown; size: number; expiresAt: number | undefined };

export class MemoryTier {
    private readonly slots = new Map<string, Slot>();
    private bytes = 0;

    constructor(
        private readonly maxEntries: number,
        private readonly maxBytes: number,
        private readonly clone: boolean
    ) {}

    get size(): number {
        return this.slots.size;
    }

    /** `undefined` = not in memory (or expired). */
    get(key: string, now: number): { value: unknown } | undefined {
        const slot = this.slots.get(key);
        if (!slot) return undefined;
        if (slot.expiresAt !== undefined && now > slot.expiresAt) {
            this.delete(key);
            return undefined;
        }
        this.slots.delete(key);
        this.slots.set(key, slot);
        return { value: this.clone ? structuredClone(slot.value) : slot.value };
    }

    set(key: string, value: unknown, size: number, expiresAt: number | undefined): void {
        if (size > this.maxBytes) {
            this.delete(key);
            return;
        }
        this.delete(key);
        this.slots.set(key, {
            value: this.clone ? structuredClone(value) : value,
            size,
            expiresAt,
        });
        this.bytes += size;
        while (this.slots.size > this.maxEntries || this.bytes > this.maxBytes) {
            const oldest = this.slots.keys().next();
            if (oldest.done) break;
            this.delete(oldest.value);
        }
    }

    /** Update the expiry of a cached value (touch / sliding TTL). */
    setExpiry(key: string, expiresAt: number | undefined): void {
        const slot = this.slots.get(key);
        if (slot) slot.expiresAt = expiresAt;
    }

    delete(key: string): void {
        const slot = this.slots.get(key);
        if (!slot) return;
        this.bytes -= slot.size;
        this.slots.delete(key);
    }

    clear(): void {
        this.slots.clear();
        this.bytes = 0;
    }
}
