// ==============================
// Base64 for bytes (chunked, no stack blow-up on large arrays)
// ==============================

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(
            null,
            bytes.subarray(i, i + CHUNK) as unknown as number[]
        );
    }
    if (typeof btoa === "function") return btoa(binary);
    const buffer = (
        globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } }
    ).Buffer;
    if (buffer) return buffer.from(binary, "latin1").toString("base64");
    throw new Error("No Base64 encoder available in this environment");
}

export function base64ToBytes(base64: string): Uint8Array {
    let binary: string;
    if (typeof atob === "function") {
        binary = atob(base64);
    } else {
        const buffer = (
            globalThis as {
                Buffer?: { from(s: string, e: string): { toString(e: string): string } };
            }
        ).Buffer;
        if (!buffer) throw new Error("No Base64 decoder available in this environment");
        binary = buffer.from(base64, "base64").toString("latin1");
    }
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}
