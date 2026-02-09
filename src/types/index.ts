export type CacheEntry<T = any> = {
    value: T | string | Uint8Array;
    isEncoded: boolean;
    isCompressed: boolean;
    createdAt: number;
    lastAccessed: number;
    expiresAt?: number;
    size: number;
};

export type CacheSetOptions = {
    ttl?: number;
    encode?: boolean;
    forceCompress?: boolean;
};

export type CacheGetOptions<T> = {
    staleWhileRevalidate?: boolean;
    revalidate?: () => Promise<T>;
    ttlOnRevalidate?: number;
};

export type CacheConfig = {
    dbName?: string;
    version?: number;
    storeName?: string;
    maxSize?: number;
    compressionThreshold?: number;
    namespace?: string;
};
