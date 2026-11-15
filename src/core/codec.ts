import { base64ToBytes } from "../base64";
import { compressBytes, decompress, isCompressionSupported, isGzip } from "../compression";
import type { KeyRing } from "../crypto";
import { CacheError } from "../errors";
import type { StoredMeta, StoredPayload, StoredRecord } from "../storage/types";
import type { CompressionAlgorithm, Serializer } from "../types";
import { decodeLegacyBase64, encodeLegacyBase64, utf8ByteLength } from "../utils";

// ==============================
// Entry codec: value ⇄ stored payload
//
//   value ─serialize→ text ─[compress]→ bytes ─[encrypt]→ bytes
//                     text ─[legacy base64 "encode"]→ text
// ==============================

export type ResolvedCompression = {
    algorithm: CompressionAlgorithm;
    threshold: number;
    minRatio: number;
};

export type CodecContext = {
    keyring: KeyRing;
    serializers: ReadonlyMap<string, Serializer>;
    writer: Serializer;
    compression: ResolvedCompression | false;
};

export type EncodeOptions = {
    encode?: boolean | undefined;
    compress?: boolean | undefined;
    forceCompress?: boolean | undefined;
    encrypt?: boolean | undefined;
};

export type Encoded = {
    payload: StoredPayload;
    size: number;
    /** Serialized size (always set — used for the memory tier budget). */
    rawSize: number;
    meta: Pick<
        StoredMeta,
        | "size"
        | "originalSize"
        | "isCompressed"
        | "compression"
        | "isEncoded"
        | "isEncrypted"
        | "keyId"
        | "serializer"
    >;
};

export async function encodeValue(
    ctx: CodecContext,
    value: unknown,
    opt: EncodeOptions
): Promise<Encoded> {
    if (value === undefined) {
        throw new CacheError(
            "Value cannot be cached: `undefined` (use `remove()` to delete a key)",
            "INVALID_VALUE"
        );
    }
    const text = ctx.writer.serialize(value);
    const rawSize = utf8ByteLength(text);
    return encodeText(ctx, text, rawSize, opt);
}

/** Encode already-serialized text (also used to re-encode during import / rotation). */
export async function encodeText(
    ctx: CodecContext,
    text: string,
    rawSize: number,
    opt: EncodeOptions,
    serializerName: string = ctx.writer.name
): Promise<Encoded> {
    let payload: StoredPayload = text;
    let size = rawSize;
    let compression: CompressionAlgorithm | undefined;
    let encoded = false;

    const c = ctx.compression;
    if (
        c &&
        opt.compress !== false &&
        (opt.forceCompress || rawSize > c.threshold) &&
        isCompressionSupported()
    ) {
        const bytes = new TextEncoder().encode(text);
        const compressed = await compressBytes(bytes, c.algorithm);
        // Already-compressed data (images, archives…) doesn't shrink: keep it as-is.
        if (opt.forceCompress || compressed.byteLength <= bytes.byteLength * c.minRatio) {
            payload = compressed;
            size = compressed.byteLength;
            compression = c.algorithm;
        }
    }
    if (compression === undefined && opt.encode) {
        payload = encodeLegacyBase64(text);
        size = (payload as string).length;
        encoded = true;
    }

    let keyId: string | undefined;
    if (opt.encrypt) {
        const plain = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
        const result = await ctx.keyring.encrypt(plain);
        payload = result.data;
        keyId = result.keyId;
        size = payload.byteLength;
    }

    return {
        payload,
        size,
        rawSize,
        meta: {
            size,
            originalSize: compression ? rawSize : undefined,
            isCompressed: compression !== undefined,
            compression,
            isEncoded: encoded,
            isEncrypted: opt.encrypt === true,
            keyId,
            serializer: serializerName,
        },
    };
}

/** Undo encryption only: returns the inner payload (text or compressed bytes). */
export async function decryptPayload(
    ctx: CodecContext,
    record: StoredRecord
): Promise<StoredPayload> {
    const { meta, payload } = record;
    if (!meta.isEncrypted) return payload;
    if (!(payload instanceof Uint8Array)) {
        throw new CacheError("Encrypted entry has a non-binary payload", "CORRUPT_ENTRY");
    }
    const bytes = await ctx.keyring.decrypt(payload, meta.keyId);
    if (meta.kind === "blob") return bytes;
    if (meta.isCompressed) {
        if (meta.compression !== undefined || isGzip(bytes)) return bytes;
        // ≤0.4 format: compressed bytes serialized as a JSON array before encryption.
        return new Uint8Array(JSON.parse(new TextDecoder().decode(bytes)) as number[]);
    }
    return new TextDecoder().decode(bytes);
}

/** Payload → serialized text (decrypt, decompress, un-base64). */
export async function decodeText(ctx: CodecContext, record: StoredRecord): Promise<string> {
    let inner = await decryptPayload(ctx, record);
    const { meta } = record;
    if (meta.isCompressed) {
        if (!(inner instanceof Uint8Array)) {
            throw new CacheError("Compressed entry has a non-binary payload", "CORRUPT_ENTRY");
        }
        inner = await decompress(inner, meta.compression);
    }
    if (typeof inner !== "string") {
        throw new CacheError("Entry payload is not text", "CORRUPT_ENTRY");
    }
    return meta.isEncoded ? decodeLegacyBase64(inner) : inner;
}

export async function decodeRecord(ctx: CodecContext, record: StoredRecord): Promise<unknown> {
    const text = await decodeText(ctx, record);
    const name = record.meta.serializer ?? "json";
    const serializer = ctx.serializers.get(name);
    if (!serializer) {
        throw new CacheError(
            `Entry was written with serializer "${name}", which is not configured (add it to \`serializers\`)`,
            "UNKNOWN_SERIALIZER"
        );
    }
    return serializer.deserialize(text);
}

// ==============================
// ≤0.5 records
// ==============================

type LegacyEntry = {
    value: unknown;
    isEncoded: boolean;
    isCompressed: boolean;
    isEncrypted?: boolean;
    createdAt: number;
    lastAccessed: number;
    accessCount?: number;
    expiresAt?: number;
    size: number;
    originalSize?: number;
    tags?: string[];
    metadata?: Record<string, unknown>;
    priority?: number;
};

export function isLegacyEntry(entry: unknown): entry is LegacyEntry {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Partial<LegacyEntry>;
    return (
        (typeof e.value === "string" || e.value instanceof Uint8Array) &&
        typeof e.size === "number" &&
        Number.isFinite(e.size) &&
        typeof e.createdAt === "number" &&
        typeof e.lastAccessed === "number" &&
        typeof e.isEncoded === "boolean" &&
        typeof e.isCompressed === "boolean"
    );
}

/** Map a ≤0.5 record to the 1.x layout (`undefined` when malformed). */
export function convertLegacy(entry: unknown): StoredRecord | undefined {
    if (!isLegacyEntry(entry)) return undefined;
    const payload = entry.value as StoredPayload;
    const encrypted = entry.isEncrypted ?? false;
    const isBlob = payload instanceof Uint8Array && !entry.isCompressed && !encrypted;
    const meta: StoredMeta = {
        size: entry.size,
        createdAt: entry.createdAt,
        lastAccessed: entry.lastAccessed,
        accessCount: entry.accessCount ?? 0,
        isCompressed: entry.isCompressed,
        isEncrypted: encrypted,
        isEncoded: entry.isEncoded,
        serializer: "json",
        kind: isBlob ? "blob" : "value",
    };
    if (entry.expiresAt !== undefined) meta.expiresAt = entry.expiresAt;
    if (entry.originalSize !== undefined) meta.originalSize = entry.originalSize;
    if (entry.priority !== undefined) meta.priority = entry.priority;
    if (entry.tags?.length) meta.tags = [...entry.tags];
    if (entry.metadata !== undefined) meta.metadata = entry.metadata;
    return { meta, payload };
}

/** Bytes of an exported payload. */
export function payloadFromExport(payload: string | { b64: string }): StoredPayload {
    return typeof payload === "string" ? payload : base64ToBytes(payload.b64);
}
