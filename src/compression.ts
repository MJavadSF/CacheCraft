import type { CompressionAlgorithm } from "./types";

// ==============================
// Compression (CompressionStream: Chrome 80+, Firefox 113+, Safari 16.4+)
// ==============================

type StreamPair = {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<BufferSource>;
};

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
    }
    if (chunks.length === 1) return chunks[0] as Uint8Array;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/**
 * Push `input` through a (De)CompressionStream. Writer and reader MUST run
 * concurrently: awaiting `write()` before reading deadlocks once the output
 * exceeds the stream's internal buffer (large / incompressible payloads).
 */
async function runStream(pair: StreamPair, input: Uint8Array): Promise<Uint8Array> {
    const writer = pair.writable.getWriter();
    const writing = writer.write(input as Uint8Array<ArrayBuffer>).then(() => writer.close());
    // Failures surface through the readable side below; avoid an unhandled rejection.
    writing.catch(() => undefined);
    const out = await readAll(pair.readable);
    await writing;
    return out;
}

/** True when the runtime can compress with `CompressionStream`. */
export function isCompressionSupported(): boolean {
    return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

/** True when the bytes start with the gzip magic number (0x1f 0x8b). */
export function isGzip(data: Uint8Array): boolean {
    return data.byteLength > 2 && data[0] === 0x1f && data[1] === 0x8b;
}

/** Compress bytes. Requires `CompressionStream` (check {@link isCompressionSupported}). */
export function compressBytes(
    data: Uint8Array,
    algorithm: CompressionAlgorithm = "gzip"
): Promise<Uint8Array> {
    return runStream(new CompressionStream(algorithm), data);
}

export function decompressBytes(
    data: Uint8Array,
    algorithm: CompressionAlgorithm = "gzip"
): Promise<Uint8Array> {
    return runStream(new DecompressionStream(algorithm), data);
}

/**
 * Compress a string. Without `CompressionStream` the UTF-8 bytes are returned
 * unchanged (and {@link decompress} detects that).
 */
export async function compress(
    data: string,
    algorithm: CompressionAlgorithm = "gzip"
): Promise<Uint8Array> {
    const bytes = new TextEncoder().encode(data);
    if (!isCompressionSupported()) return bytes;
    return compressBytes(bytes, algorithm);
}

/**
 * Decompress to a string. With no `algorithm` (≤0.5 entries) the data is gunzipped
 * when it carries the gzip magic number and treated as raw UTF-8 otherwise.
 */
export async function decompress(
    data: Uint8Array,
    algorithm?: CompressionAlgorithm
): Promise<string> {
    const decoder = new TextDecoder();
    if (algorithm === undefined || algorithm === "gzip") {
        if (!isGzip(data) || typeof DecompressionStream === "undefined")
            return decoder.decode(data);
        return decoder.decode(await decompressBytes(data, "gzip"));
    }
    return decoder.decode(await decompressBytes(data, algorithm));
}
