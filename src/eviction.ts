import type { CacheEntryMeta, EvictionPolicy } from "./types";

// ==============================
// CacheCraft Eviction Policies
//
// Policies work on lightweight metadata only (no payloads). Each built-in policy
// exposes `rank()` — entries ordered most-evictable first — which the engine also
// uses for entry-count and per-tag budgets. `shouldEvict()` frees bytes from the
// front of that ranking.
//
// The engine hands entries over in recency order (least recently used first), so
// the LRU sort is effectively linear.
// ==============================

/** Take entries from the front of `ranked` until `bytesToFree` is covered. */
export function collect(ranked: readonly CacheEntryMeta[], bytesToFree: number): string[] {
    const keys: string[] = [];
    let remaining = bytesToFree;
    for (const item of ranked) {
        if (remaining <= 0) break;
        keys.push(item.key);
        remaining -= item.size;
    }
    return keys;
}

abstract class RankedPolicy implements EvictionPolicy {
    abstract name: string;
    abstract rank(entries: CacheEntryMeta[]): CacheEntryMeta[];

    shouldEvict(entries: CacheEntryMeta[], maxSize: number, currentSize: number): string[] {
        if (currentSize <= maxSize) return [];
        return collect(this.rank(entries), currentSize - maxSize);
    }
}

const byLastAccessed = (a: CacheEntryMeta, b: CacheEntryMeta): number =>
    a.lastAccessed - b.lastAccessed;

/** Least Recently Used. */
export class LRUEvictionPolicy extends RankedPolicy {
    name = "lru";
    rank(entries: CacheEntryMeta[]): CacheEntryMeta[] {
        return [...entries].sort(byLastAccessed);
    }
}

/** Least Frequently Used (LRU tiebreaker). */
export class LFUEvictionPolicy extends RankedPolicy {
    name = "lfu";
    rank(entries: CacheEntryMeta[]): CacheEntryMeta[] {
        return [...entries].sort((a, b) =>
            a.accessCount !== b.accessCount ? a.accessCount - b.accessCount : byLastAccessed(a, b)
        );
    }
}

/** First In, First Out. */
export class FIFOEvictionPolicy extends RankedPolicy {
    name = "fifo";
    rank(entries: CacheEntryMeta[]): CacheEntryMeta[] {
        return [...entries].sort((a, b) => a.createdAt - b.createdAt);
    }
}

/** Lowest `priority` first (LRU tiebreaker). */
export class PriorityEvictionPolicy extends RankedPolicy {
    name = "priority";
    rank(entries: CacheEntryMeta[]): CacheEntryMeta[] {
        return [...entries].sort((a, b) => {
            const pa = a.priority ?? 0;
            const pb = b.priority ?? 0;
            return pa !== pb ? pa - pb : byLastAccessed(a, b);
        });
    }
}

/**
 * Frequency-segmented LRU: single-access ("cold") entries go first, then
 * repeatedly-used ("hot") ones — scan-resistant, like ARC, without ghost lists.
 */
export class SegmentedEvictionPolicy extends RankedPolicy {
    name = "segmented";
    rank(entries: CacheEntryMeta[]): CacheEntryMeta[] {
        const cold = entries.filter((e) => e.accessCount <= 1).sort(byLastAccessed);
        const hot = entries
            .filter((e) => e.accessCount > 1)
            .sort((a, b) =>
                a.accessCount !== b.accessCount
                    ? a.accessCount - b.accessCount
                    : byLastAccessed(a, b)
            );
        return [...cold, ...hot];
    }
}

/** @deprecated Renamed to {@link SegmentedEvictionPolicy}. */
export class ARCEvictionPolicy extends SegmentedEvictionPolicy {
    override name = "segmented";
}

/**
 * Expired first, then nearest-to-expiry, then (entries without TTL) LRU — so the
 * cache can never grow past its budget.
 */
export class TTLEvictionPolicy extends RankedPolicy {
    name = "ttl";
    rank(entries: CacheEntryMeta[]): CacheEntryMeta[] {
        const withTtl = entries
            .filter((e) => e.expiresAt !== undefined)
            .sort((a, b) => (a.expiresAt as number) - (b.expiresAt as number));
        const rest = entries.filter((e) => e.expiresAt === undefined).sort(byLastAccessed);
        return [...withTtl, ...rest];
    }
}

/** Largest first. */
export class SizeBasedEvictionPolicy extends RankedPolicy {
    name = "size";
    rank(entries: CacheEntryMeta[]): CacheEntryMeta[] {
        return [...entries].sort((a, b) => b.size - a.size);
    }
}

export function createEvictionPolicy(strategy: string): EvictionPolicy {
    switch (strategy) {
        case "lfu":
            return new LFUEvictionPolicy();
        case "fifo":
            return new FIFOEvictionPolicy();
        case "priority":
            return new PriorityEvictionPolicy();
        case "segmented":
        case "arc":
            return new SegmentedEvictionPolicy();
        case "ttl":
            return new TTLEvictionPolicy();
        case "size":
            return new SizeBasedEvictionPolicy();
        default:
            return new LRUEvictionPolicy();
    }
}

/** Ranking used for count/tag budgets: the policy's own, or LRU. */
export function rankFor(policy: EvictionPolicy, entries: CacheEntryMeta[]): CacheEntryMeta[] {
    return policy.rank ? policy.rank(entries) : [...entries].sort(byLastAccessed);
}
