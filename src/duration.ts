import { CacheError } from "./errors";
import type { Duration, Size } from "./types";

// ==============================
// Human-friendly durations and sizes
// ==============================

const DURATION_UNITS: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
};

const DURATION_PART = /(\d+(?:\.\d+)?|\.\d+)\s*(ms|s|m|h|d|w)/gy;

/** `"1h30m"` → 5_400_000. Numbers are milliseconds. Throws on malformed input. */
export function parseDuration(value: Duration): number {
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value < 0) {
            throw new CacheError(`Invalid duration: ${value}`, "INVALID_DURATION");
        }
        return value;
    }
    const text = value.trim().toLowerCase();
    if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
    let total = 0;
    let consumed = 0;
    DURATION_PART.lastIndex = 0;
    for (;;) {
        // Allow whitespace between parts ("1h 30m").
        while (text[DURATION_PART.lastIndex] === " ") DURATION_PART.lastIndex++;
        const start = DURATION_PART.lastIndex;
        if (start >= text.length) break;
        const match = DURATION_PART.exec(text);
        if (!match) break;
        total += Number(match[1]) * (DURATION_UNITS[match[2] as string] as number);
        consumed = DURATION_PART.lastIndex;
    }
    if (consumed === 0 || text.slice(consumed).trim() !== "") {
        throw new CacheError(`Invalid duration: "${value}"`, "INVALID_DURATION");
    }
    return total;
}

/** Like {@link parseDuration} but passes `undefined` through. */
export function optionalDuration(value: Duration | undefined): number | undefined {
    return value === undefined ? undefined : parseDuration(value);
}

const SIZE_UNITS: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
};

/** `"50MB"` → 52_428_800 (binary units). Numbers are bytes. */
export function parseSize(value: Size): number {
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value < 0) {
            throw new CacheError(`Invalid size: ${value}`, "INVALID_SIZE");
        }
        return value;
    }
    const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(value);
    if (!match) throw new CacheError(`Invalid size: "${value}"`, "INVALID_SIZE");
    const unit = (match[2] ?? "b").toLowerCase();
    return Math.floor(Number(match[1]) * (SIZE_UNITS[unit] as number));
}
