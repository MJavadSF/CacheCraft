import { EvictionPolicy, CacheEntryMeta } from "./types";

// ==============================
// CacheCraft Eviction Policies — v0.4
//
// All policies operate on lightweight CacheEntryMeta (no payloads), so the
// engine can decide what to evict without ever reading stored values.
// ==============================

/** Greedy "free the oldest/least-valuable until under budget" helper. */
function collect(
    sorted: CacheEntryMeta[],
    bytesToFree: number
): string[] {
    const toEvict: string[] = [];
    let remaining = bytesToFree;
    for (const item of sorted) {
        if (remaining <= 0) break;
        toEvict.push(item.key);
        remaining -= item.size;
    }
    return toEvict;
}

// ==============================
// LRU (Least Recently Used)
// ==============================

export class LRUEvictionPolicy implements EvictionPolicy {
    name = "lru";

    shouldEvict(entries: CacheEntryMeta[], maxSize: number, currentSize: number): string[] {
        if (currentSize <= maxSize) return [];
        const sorted = [...entries].sort((a, b) => a.lastAccessed - b.lastAccessed);
        return collect(sorted, currentSize - maxSize);
    }
}

// ==============================
// LFU (Least Frequently Used)
// ==============================

export class LFUEvictionPolicy implements EvictionPolicy {
    name = "lfu";

    shouldEvict(entries: CacheEntryMeta[], maxSize: number, currentSize: number): string[] {
        if (currentSize <= maxSize) return [];
        const sorted = [...entries].sort((a, b) => {
            if (a.accessCount !== b.accessCount) return a.accessCount - b.accessCount;
            return a.lastAccessed - b.lastAccessed; // LRU tiebreaker
        });
        return collect(sorted, currentSize - maxSize);
    }
}

// ==============================
// FIFO (First In First Out)
// ==============================

export class FIFOEvictionPolicy implements EvictionPolicy {
    name = "fifo";

    shouldEvict(entries: CacheEntryMeta[], maxSize: number, currentSize: number): string[] {
        if (currentSize <= maxSize) return [];
        const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt);
        return collect(sorted, currentSize - maxSize);
    }
}

// ==============================
// Priority-Based Eviction (lowest priority first, LRU tiebreaker)
// ==============================

export class PriorityEvictionPolicy implements EvictionPolicy {
    name = "priority";

    shouldEvict(entries: CacheEntryMeta[], maxSize: number, currentSize: number): string[] {
        if (currentSize <= maxSize) return [];
        const sorted = [...entries].sort((a, b) => {
            const pa = a.priority ?? 0;
            const pb = b.priority ?? 0;
            if (pa !== pb) return pa - pb;
            return a.lastAccessed - b.lastAccessed;
        });
        return collect(sorted, currentSize - maxSize);
    }
}

// ==============================
// Segmented Eviction (frequency-segmented LRU)
//
// A pragmatic, stateless approximation of ARC: entries accessed more than once
// ("hot") are protected and only evicted after single-access ("cold") entries
// are exhausted. Within each segment, least-recently-used goes first. This
// gives scan-resistance similar to ARC without needing ghost-list bookkeeping
// that an IndexedDB-backed store cannot cheaply maintain.
// ==============================

export class SegmentedEvictionPolicy implements EvictionPolicy {
    name = "segmented";

    shouldEvict(entries: CacheEntryMeta[], maxSize: number, currentSize: number): string[] {
        if (currentSize <= maxSize) return [];

        const cold = entries.filter((e) => e.accessCount <= 1)
            .sort((a, b) => a.lastAccessed - b.lastAccessed);
        const hot = entries.filter((e) => e.accessCount > 1)
            .sort((a, b) => {
                if (a.accessCount !== b.accessCount) return a.accessCount - b.accessCount;
                return a.lastAccessed - b.lastAccessed;
            });

        return collect([...cold, ...hot], currentSize - maxSize);
    }
}

/**
 * @deprecated Renamed to {@link SegmentedEvictionPolicy}. The previous "ARC"
 * implementation was never a true Adaptive Replacement Cache; this alias keeps
 * existing configs working but the honest name is "segmented".
 */
export class ARCEvictionPolicy extends SegmentedEvictionPolicy {
    override name = "segmented";
}

// ==============================
// TTL-Based Eviction (expired first, then nearest-to-expiry)
// ==============================

export class TTLEvictionPolicy implements EvictionPolicy {
    name = "ttl";

    shouldEvict(entries: CacheEntryMeta[], maxSize: number, currentSize: number): string[] {
        if (currentSize <= maxSize) return [];

        const now = Date.now();
        const expired = entries.filter((e) => e.expiresAt !== undefined && e.expiresAt < now);

        const toEvict = expired.map((e) => e.key);
        const freed = expired.reduce((sum, e) => sum + e.size, 0);

        if (currentSize - freed > maxSize) {
            const expiredKeys = new Set(toEvict);
            const withTTL = entries
                .filter((e) => e.expiresAt !== undefined && !expiredKeys.has(e.key))
                .sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0));
            toEvict.push(...collect(withTTL, currentSize - freed - maxSize));
        }

        return toEvict;
    }
}

// ==============================
// Size-Based Eviction (largest first)
// ==============================

export class SizeBasedEvictionPolicy implements EvictionPolicy {
    name = "size";

    shouldEvict(entries: CacheEntryMeta[], maxSize: number, currentSize: number): string[] {
        if (currentSize <= maxSize) return [];
        const sorted = [...entries].sort((a, b) => b.size - a.size);
        return collect(sorted, currentSize - maxSize);
    }
}

// ==============================
// Factory
// ==============================

export function createEvictionPolicy(strategy: string): EvictionPolicy {
    switch (strategy) {
        case "lru":       return new LRUEvictionPolicy();
        case "lfu":       return new LFUEvictionPolicy();
        case "fifo":      return new FIFOEvictionPolicy();
        case "priority":  return new PriorityEvictionPolicy();
        case "segmented":
        case "arc":       return new SegmentedEvictionPolicy();
        case "ttl":       return new TTLEvictionPolicy();
        case "size":      return new SizeBasedEvictionPolicy();
        default:          return new LRUEvictionPolicy();
    }
}
