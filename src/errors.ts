// ==============================
// CacheCraft error classes
// ==============================

/** Base class of every error thrown by CacheCraft. `code` is stable and documented. */
export class CacheError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly originalError?: Error
    ) {
        super(message);
        this.name = "CacheError";
        // Keep the prototype chain intact when transpiled to ES5.
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** The storage refused a write because the origin is out of quota. */
export class QuotaExceededError extends CacheError {
    constructor(message = "Storage quota exceeded", originalError?: Error) {
        super(message, "QUOTA_EXCEEDED", originalError);
        this.name = "QuotaExceededError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Encryption was requested but is impossible, or a value could not be decrypted. */
export class EncryptionError extends CacheError {
    constructor(message: string, originalError?: Error) {
        super(message, "ENCRYPTION_ERROR", originalError);
        this.name = "EncryptionError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** The current runtime lacks a required API (e.g. IndexedDB during SSR). */
export class UnsupportedEnvironmentError extends CacheError {
    constructor(message = "Operation not supported in this environment") {
        super(message, "UNSUPPORTED_ENV");
        this.name = "UnsupportedEnvironmentError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** A `getOrSet` factory (or `cachedFetch` request) exceeded its `timeout`. */
export class TimeoutError extends CacheError {
    constructor(message = "Operation timed out") {
        super(message, "TIMEOUT");
        this.name = "TimeoutError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** A cached value failed `schema` validation (reported through `onError`). */
export class SchemaValidationError extends CacheError {
    constructor(
        message: string,
        public readonly issues: ReadonlyArray<{ readonly message: string }>
    ) {
        super(message, "SCHEMA_INVALID");
        this.name = "SchemaValidationError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Normalise anything thrown into a real `Error`. */
export function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
