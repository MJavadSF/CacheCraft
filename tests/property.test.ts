import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { destroyAll, makeCache } from "./helpers";

// Model-based test: random sequences of operations against the engine must
// behave like a plain Map, and the in-memory accounting (count, size, tags)
// must always match what is actually stored.

type Op =
    | { kind: "set"; key: string; value: string; tag: string | null }
    | { kind: "remove"; key: string }
    | { kind: "get"; key: string }
    | { kind: "invalidate"; tag: string }
    | { kind: "batch"; keys: string[] };

const key = fc.constantFrom("a", "b", "c", "d", "e", "user:1", "user:2");
const tag = fc.constantFrom("x", "y");
const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
        kind: fc.constant("set" as const),
        key,
        value: fc.string({ maxLength: 30 }),
        tag: fc.option(tag, { nil: null }),
    }),
    fc.record({ kind: fc.constant("remove" as const), key }),
    fc.record({ kind: fc.constant("get" as const), key }),
    fc.record({ kind: fc.constant("invalidate" as const), tag }),
    fc.record({ kind: fc.constant("batch" as const), keys: fc.array(key, { maxLength: 3 }) })
);

afterEach(destroyAll);

describe("model-based", () => {
    it("matches a Map and keeps accounting consistent", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(op, { maxLength: 40 }),
                fc.boolean(),
                async (ops, memoryTier) => {
                    const cache = makeCache({
                        memoryCache: memoryTier,
                        compression: { threshold: 20 },
                    });
                    const model = new Map<string, { value: string; tag: string | null }>();
                    for (const o of ops) {
                        switch (o.kind) {
                            case "set":
                                await cache.set(
                                    o.key,
                                    o.value,
                                    o.tag ? { tags: [o.tag] } : undefined
                                );
                                model.set(o.key, { value: o.value, tag: o.tag });
                                break;
                            case "remove":
                                expect(await cache.remove(o.key)).toBe(model.delete(o.key));
                                break;
                            case "get":
                                expect(await cache.get(o.key)).toBe(
                                    model.get(o.key)?.value ?? null
                                );
                                break;
                            case "invalidate": {
                                const expected = [...model]
                                    .filter(([, v]) => v.tag === o.tag)
                                    .map(([k]) => k);
                                expect(await cache.invalidateByTag(o.tag)).toBe(expected.length);
                                for (const k of expected) model.delete(k);
                                break;
                            }
                            case "batch": {
                                const results = await cache.batchDelete(o.keys);
                                const seen = new Set<string>();
                                for (const r of results) {
                                    const existed = model.has(r.key) && !seen.has(r.key);
                                    if (!seen.has(r.key)) expect(r.success).toBe(existed);
                                    seen.add(r.key);
                                }
                                for (const k of o.keys) model.delete(k);
                                break;
                            }
                        }
                    }
                    expect((await cache.keys()).sort()).toEqual([...model.keys()].sort());
                    expect(await cache.count()).toBe(model.size);
                    // Size accounting equals the sum of stored entry sizes.
                    const metas = await cache.queryMeta();
                    expect(await cache.size()).toBe(metas.reduce((s, m) => s + m.size, 0));
                    // A fresh engine (hydrated from storage) sees exactly the same state.
                    await cache.flushAccessMetadata();
                    const reloaded = makeCache({ dbName: cache.info.dbName });
                    expect((await reloaded.keys()).sort()).toEqual([...model.keys()].sort());
                    for (const [k, v] of model) expect(await reloaded.get(k)).toBe(v.value);
                    await reloaded.destroy();
                    await cache.destroy();
                }
            ),
            { numRuns: 60 }
        );
    });
});
