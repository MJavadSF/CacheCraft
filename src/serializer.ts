import { base64ToBytes, bytesToBase64 } from "./base64";
import { CacheError } from "./errors";
import type { Serializer } from "./types";

// ==============================
// Serializers
//
// "json"  — plain JSON.stringify / JSON.parse (the ≤0.5 format).
// "rich"  — JSON with tagged values, so Date, Map, Set, BigInt, RegExp, URL,
//           Error, typed arrays, ArrayBuffer, NaN/±Infinity, -0 and nested
//           `undefined` survive a round-trip. Plain JSON data serializes to
//           exactly the same text as "json" (tags are only added where needed).
// ==============================

export const jsonSerializer: Serializer = {
    name: "json",
    serialize(value: unknown): string {
        const text = JSON.stringify(value);
        if (text === undefined) {
            throw new CacheError(
                "Value cannot be cached: it is not JSON-serializable (undefined, function or symbol)",
                "INVALID_VALUE"
            );
        }
        return text;
    },
    deserialize(text: string): unknown {
        return JSON.parse(text);
    },
};

const TAG = "$cc";

type Tagged = { [TAG]: string; v?: unknown };

type TypedArrayCtor = new (buffer: ArrayBuffer) => ArrayBufferView;

function typedArrayCtors(): Record<string, TypedArrayCtor | undefined> {
    const g = globalThis as unknown as Record<string, TypedArrayCtor | undefined>;
    return {
        Int8Array: g.Int8Array,
        Uint8Array: g.Uint8Array,
        Uint8ClampedArray: g.Uint8ClampedArray,
        Int16Array: g.Int16Array,
        Uint16Array: g.Uint16Array,
        Int32Array: g.Int32Array,
        Uint32Array: g.Uint32Array,
        Float32Array: g.Float32Array,
        Float64Array: g.Float64Array,
        BigInt64Array: g.BigInt64Array,
        BigUint64Array: g.BigUint64Array,
        DataView: g.DataView,
    };
}

function isPlainObject(value: object): boolean {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function replace(this: unknown, key: string, jsonValue: unknown): unknown {
    // `this[key]` is the value *before* toJSON() (Date → string) ran.
    const raw = (this as Record<string, unknown>)[key];

    switch (typeof raw) {
        case "undefined":
            return { [TAG]: "U" };
        case "number":
            if (Number.isNaN(raw)) return { [TAG]: "N", v: "NaN" };
            if (raw === Number.POSITIVE_INFINITY) return { [TAG]: "N", v: "Infinity" };
            if (raw === Number.NEGATIVE_INFINITY) return { [TAG]: "N", v: "-Infinity" };
            if (Object.is(raw, -0)) return { [TAG]: "N", v: "-0" };
            return raw;
        case "bigint":
            return { [TAG]: "BigInt", v: raw.toString() };
        case "function":
        case "symbol":
            return undefined; // dropped, like JSON
        case "object": {
            if (raw === null) return null;
            if (raw instanceof Date) {
                const time = raw.getTime();
                return { [TAG]: "Date", v: Number.isNaN(time) ? null : time };
            }
            if (raw instanceof Map) return { [TAG]: "Map", v: Array.from(raw.entries()) };
            if (raw instanceof Set) return { [TAG]: "Set", v: Array.from(raw.values()) };
            if (raw instanceof RegExp) return { [TAG]: "RegExp", v: [raw.source, raw.flags] };
            if (typeof URL !== "undefined" && raw instanceof URL) {
                return { [TAG]: "URL", v: raw.href };
            }
            if (raw instanceof Error) {
                return { [TAG]: "Error", v: [raw.name, raw.message, raw.stack ?? null] };
            }
            if (raw instanceof ArrayBuffer) {
                return { [TAG]: "ArrayBuffer", v: bytesToBase64(new Uint8Array(raw)) };
            }
            if (ArrayBuffer.isView(raw)) {
                const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
                const ctors = typedArrayCtors();
                // Subclasses (e.g. Node's Buffer) are stored as their standard base type.
                const name =
                    Object.keys(ctors).find((n) => {
                        const ctor = ctors[n];
                        return ctor !== undefined && raw instanceof ctor;
                    }) ?? "Uint8Array";
                return { [TAG]: name, v: bytesToBase64(bytes), b: 1 };
            }
            if (!Array.isArray(raw) && isPlainObject(raw) && TAG in raw) {
                // A user object that happens to own our tag key: escape it.
                return { [TAG]: "Esc", v: Object.entries(raw) };
            }
            return jsonValue;
        }
        default:
            return jsonValue;
    }
}

function revive(node: unknown): unknown {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) node[i] = revive(node[i]);
        return node;
    }
    const obj = node as Record<string, unknown>;
    const tag = obj[TAG];
    if (typeof tag === "string") return reviveTagged(obj as Tagged);
    for (const k of Object.keys(obj)) {
        obj[k] = revive(obj[k]);
    }
    return obj;
}

function reviveTagged(node: Tagged & { b?: number }): unknown {
    const v = node.v;
    switch (node[TAG]) {
        case "U":
            return undefined;
        case "N":
            return v === "-0" ? -0 : Number(v);
        case "BigInt":
            return BigInt(v as string);
        case "Date":
            return new Date(v === null ? Number.NaN : (v as number));
        case "Map":
            return new Map(
                (v as Array<[unknown, unknown]>).map(([k, x]) => [revive(k), revive(x)])
            );
        case "Set":
            return new Set((v as unknown[]).map(revive));
        case "RegExp": {
            const [source, flags] = v as [string, string];
            return new RegExp(source, flags);
        }
        case "URL":
            return new URL(v as string);
        case "Error": {
            const [name, message, stack] = v as [string, string, string | null];
            const error = new Error(message);
            error.name = name;
            if (stack !== null) error.stack = stack;
            return error;
        }
        case "ArrayBuffer": {
            const bytes = base64ToBytes(v as string);
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        }
        case "Esc": {
            const out: Record<string, unknown> = {};
            for (const [k, x] of v as Array<[string, unknown]>) out[k] = revive(x);
            return out;
        }
        default: {
            if (node.b === 1) {
                const ctor = typedArrayCtors()[node[TAG]];
                if (ctor) {
                    const bytes = base64ToBytes(v as string);
                    const buffer = bytes.buffer.slice(
                        bytes.byteOffset,
                        bytes.byteOffset + bytes.byteLength
                    ) as ArrayBuffer;
                    return new ctor(buffer);
                }
            }
            // Unknown tag (written by a newer version?) — keep the raw object.
            return node;
        }
    }
}

export const richSerializer: Serializer = {
    name: "rich",
    serialize(value: unknown): string {
        const text = JSON.stringify(value, replace);
        if (text === undefined) {
            throw new CacheError(
                "Value cannot be cached: functions and symbols are not serializable",
                "INVALID_VALUE"
            );
        }
        return text;
    },
    deserialize(text: string): unknown {
        return revive(JSON.parse(text));
    },
};

/** Registry used to read entries: built-ins plus any user-provided serializers. */
export function serializerRegistry(extra: readonly Serializer[] = []): Map<string, Serializer> {
    const map = new Map<string, Serializer>([
        [jsonSerializer.name, jsonSerializer],
        [richSerializer.name, richSerializer],
    ]);
    for (const s of extra) map.set(s.name, s);
    return map;
}
