import { EvictionPolicy, CacheEntryWithKey } from "./types";

// ==============================
// LRU (Least Recently Used)
// ==============================

export class LRUEvictionPolicy implements EvictionPolicy {
    name = "lru";

    shouldEvict(
        entries: CacheEntryWithKey[],
        maxSize: number,
        currentSize: number
    ): string[] {
        if (currentSize <= maxSize) return [];

        // Sort by last accessed (oldest first)
        const sorted = [...entries].sort(
            (a, b) => a.entry.lastAccessed - b.entry.lastAccessed
        );

        const toEvict: string[] = [];
        let sizeToFree = currentSize - maxSize;

        for (const item of sorted) {
            if (sizeToFree <= 0) break;
            toEvict.push(item.key);
            sizeToFree -= item.entry.size;
        }

        return toEvict;
    }
}

// ==============================
// LFU (Least Frequently Used)
// ==============================

export class LFUEvictionPolicy implements EvictionPolicy {
    name = "lfu";

    shouldEvict(
        entries: CacheEntryWithKey[],
        maxSize: number,
        currentSize: number
    ): string[] {
        if (currentSize <= maxSize) return [];

        // Sort by access count (least accessed first)
        const sorted = [...entries].sort((a, b) => {
            const countA = a.entry.accessCount || 0;
            const countB = b.entry.accessCount || 0;
            if (countA !== countB) return countA - countB;
            // If same count, use LRU as tiebreaker
            return a.entry.lastAccessed - b.entry.lastAccessed;
        });

        const toEvict: string[] = [];
        let sizeToFree = currentSize - maxSize;

        for (const item of sorted) {
            if (sizeToFree <= 0) break;
            toEvict.push(item.key);
            sizeToFree -= item.entry.size;
        }

        return toEvict;
    }
}

// ==============================
// FIFO (First In First Out)
// ==============================

export class FIFOEvictionPolicy implements EvictionPolicy {
    name = "fifo";

    shouldEvict(
        entries: CacheEntryWithKey[],
        maxSize: number,
        currentSize: number
    ): string[] {
        if (currentSize <= maxSize) return [];

        // Sort by creation time (oldest first)
        const sorted = [...entries].sort(
            (a, b) => a.entry.createdAt - b.entry.createdAt
        );

        const toEvict: string[] = [];
        let sizeToFree = currentSize - maxSize;

        for (const item of sorted) {
            if (sizeToFree <= 0) break;
            toEvict.push(item.key);
            sizeToFree -= item.entry.size;
        }

        return toEvict;
    }
}

// ==============================
// Priority-Based Eviction
// ==============================

export class PriorityEvictionPolicy implements EvictionPolicy {
    name = "priority";

    shouldEvict(
        entries: CacheEntryWithKey[],
        maxSize: number,
        currentSize: number
    ): string[] {
        if (currentSize <= maxSize) return [];

        // Sort by priority (lowest first), then by LRU
        const sorted = [...entries].sort((a, b) => {
            const priorityA = a.entry.priority ?? 0;
            const priorityB = b.entry.priority ?? 0;
            if (priorityA !== priorityB) return priorityA - priorityB;
            // If same priority, use LRU as tiebreaker
            return a.entry.lastAccessed - b.entry.lastAccessed;
        });

        const toEvict: string[] = [];
        let sizeToFree = currentSize - maxSize;

        for (const item of sorted) {
            if (sizeToFree <= 0) break;
            toEvict.push(item.key);
            sizeToFree -= item.entry.size;
        }

        return toEvict;
    }
}

// ==============================
// Adaptive Replacement Cache (ARC)
// ==============================

export class ARCEvictionPolicy implements EvictionPolicy {
    name = "arc";
    private t1 = new Set<string>(); // Recently used once
    private t2 = new Set<string>(); // Frequently used
    private b1 = new Set<string>(); // Ghost entries for t1
    private b2 = new Set<string>(); // Ghost entries for t2
    private p = 0; // Target size for t1

    shouldEvict(
        entries: CacheEntryWithKey[],
        maxSize: number,
        currentSize: number
    ): string[] {
        if (currentSize <= maxSize) return [];

        const toEvict: string[] = [];
        let sizeToFree = currentSize - maxSize;

        // Simplified ARC: evict from t1 first, then t2
        const t1Entries = entries.filter((e) => {
            const count = e.entry.accessCount || 0;
            return count <= 1;
        });

        const t2Entries = entries.filter((e) => {
            const count = e.entry.accessCount || 0;
            return count > 1;
        });

        // Sort t1 by LRU, t2 by LFU
        t1Entries.sort((a, b) => a.entry.lastAccessed - b.entry.lastAccessed);
        t2Entries.sort((a, b) => {
            const countA = a.entry.accessCount || 0;
            const countB = b.entry.accessCount || 0;
            return countA - countB;
        });

        for (const item of [...t1Entries, ...t2Entries]) {
            if (sizeToFree <= 0) break;
            toEvict.push(item.key);
            sizeToFree -= item.entry.size;
        }

        return toEvict;
    }
}

// ==============================
// TTL-Based Eviction
// ==============================

export class TTLEvictionPolicy implements EvictionPolicy {
    name = "ttl";

    shouldEvict(
        entries: CacheEntryWithKey[],
        maxSize: number,
        currentSize: number
    ): string[] {
        if (currentSize <= maxSize) return [];

        const now = Date.now();

        // First, evict expired entries
        const expired = entries.filter(
            (e) => e.entry.expiresAt && e.entry.expiresAt < now
        );

        let toEvict = expired.map((e) => e.key);
        let sizeFreed = expired.reduce((sum, e) => sum + e.entry.size, 0);

        // If still over limit, evict entries closest to expiration
        if (currentSize - sizeFreed > maxSize) {
            const withTTL = entries
                .filter((e) => e.entry.expiresAt && !expired.includes(e))
                .sort((a, b) => (a.entry.expiresAt || 0) - (b.entry.expiresAt || 0));

            let sizeToFree = currentSize - sizeFreed - maxSize;

            for (const item of withTTL) {
                if (sizeToFree <= 0) break;
                toEvict.push(item.key);
                sizeToFree -= item.entry.size;
            }
        }

        return toEvict;
    }
}

// ==============================
// Size-Based Eviction (evict largest first)
// ==============================

export class SizeBasedEvictionPolicy implements EvictionPolicy {
    name = "size";

    shouldEvict(
        entries: CacheEntryWithKey[],
        maxSize: number,
        currentSize: number
    ): string[] {
        if (currentSize <= maxSize) return [];

        // Sort by size (largest first)
        const sorted = [...entries].sort((a, b) => b.entry.size - a.entry.size);

        const toEvict: string[] = [];
        let sizeToFree = currentSize - maxSize;

        for (const item of sorted) {
            if (sizeToFree <= 0) break;
            toEvict.push(item.key);
            sizeToFree -= item.entry.size;
        }

        return toEvict;
    }
}

// ==============================
// Factory
// ==============================

export function createEvictionPolicy(strategy: string): EvictionPolicy {
    switch (strategy) {
        case "lru":
            return new LRUEvictionPolicy();
        case "lfu":
            return new LFUEvictionPolicy();
        case "fifo":
            return new FIFOEvictionPolicy();
        case "priority":
            return new PriorityEvictionPolicy();
        case "arc":
            return new ARCEvictionPolicy();
        case "ttl":
            return new TTLEvictionPolicy();
        case "size":
            return new SizeBasedEvictionPolicy();
        default:
            return new LRUEvictionPolicy();
    }
}
