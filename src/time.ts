// ==============================
// Time helpers
// ==============================

/** True when `expiresAt` is set and has been reached (a TTL of 0 is expired immediately). */
export function isExpired(expiresAt: number | undefined, now: number = Date.now()): boolean {
    return expiresAt !== undefined && now >= expiresAt;
}

/** Absolute expiry for a TTL in ms (`undefined` = never). */
export function calculateTTL(
    ttl: number | undefined,
    now: number = Date.now()
): number | undefined {
    return ttl !== undefined ? now + ttl : undefined;
}

export function getAge(createdAt: number, now: number = Date.now()): number {
    return now - createdAt;
}

/** Milliseconds until expiry: `null` = never expires, `0` = already expired. */
export function getTimeUntilExpiry(
    expiresAt: number | undefined,
    now: number = Date.now()
): number | null {
    if (expiresAt === undefined) return null;
    const remaining = expiresAt - now;
    return remaining > 0 ? remaining : 0;
}

/** `performance.now()` when available. */
export function now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}
