import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CacheEngine } from "../src";
import { useCache, useCacheStats, useCacheValue } from "../src/react";
import { destroyAll, makeCache, sleep } from "./helpers";

beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(element: ReactElement): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root?.render(element);
    });
}

async function flush(ms = 30): Promise<void> {
    await act(async () => {
        await sleep(ms);
    });
}

afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    await destroyAll();
});

describe("useCache", () => {
    it("loads through getOrSet and shows data", async () => {
        const engine = makeCache();
        let calls = 0;
        function View() {
            const { data, isLoading } = useCache(
                "k",
                async () => {
                    calls++;
                    return { n: 1 };
                },
                { engine }
            );
            return createElement("p", { id: "out" }, isLoading ? "loading" : JSON.stringify(data));
        }
        await render(createElement(View));
        await flush();
        expect(container?.querySelector("#out")?.textContent).toBe('{"n":1}');
        expect(calls).toBe(1);
    });

    it("does not show the previous key's data when the key changes", async () => {
        const engine = makeCache();
        function View({ id }: { id: string }) {
            const { data } = useCache(
                `user:${id}`,
                async () => {
                    await sleep(id === "1" ? 40 : 5);
                    return `user-${id}`;
                },
                { engine }
            );
            return createElement("p", { id: "out" }, data ?? "none");
        }
        await render(createElement(View, { id: "1" }));
        // Switch before the slow first request resolves: its late result must be ignored.
        await act(async () => root?.render(createElement(View, { id: "2" })));
        await flush(120);
        expect(container?.querySelector("#out")?.textContent).toBe("user-2");
    });

    it("an explicit engine never creates a shared default engine", async () => {
        const engine = makeCache();
        function View() {
            useCache("k", () => 1, { engine });
            return null;
        }
        await render(createElement(View));
        await flush();
        const names = ((await indexedDB.databases()) ?? []).map((d) => d.name);
        // The hook must not have spun up the default "cache-db" engine on the side.
        expect(names).not.toContain("cache-db");
    });

    it("refresh() keeps the cached value when the factory fails", async () => {
        const engine = makeCache();
        await engine.set("k", "cached");
        let fail = false;
        let refresh: () => Promise<void> = async () => undefined;
        function View() {
            const s = useCache<string>(
                "k",
                async () => {
                    if (fail) throw new Error("down");
                    return "fresh";
                },
                { engine }
            );
            refresh = s.refresh;
            return createElement(
                "p",
                { id: "out" },
                `${s.data ?? "none"}|${s.error?.message ?? ""}`
            );
        }
        await render(createElement(View));
        await flush();
        expect(container?.querySelector("#out")?.textContent).toBe("cached|");
        fail = true;
        await act(async () => refresh());
        await flush();
        expect(container?.querySelector("#out")?.textContent).toBe("cached|down");
        expect(await engine.get("k")).toBe("cached");
    });
});

describe("useCacheValue", () => {
    it("reflects writes and deletes", async () => {
        const engine = makeCache();
        function View() {
            const v = useCacheValue<string>("k", { engine });
            return createElement("p", { id: "out" }, v ?? "none");
        }
        await render(createElement(View));
        await flush();
        expect(container?.querySelector("#out")?.textContent).toBe("none");
        await act(async () => engine.set("k", "hello"));
        await flush();
        expect(container?.querySelector("#out")?.textContent).toBe("hello");
        await act(async () => {
            await engine.remove("k");
        });
        await flush();
        expect(container?.querySelector("#out")?.textContent).toBe("none");
    });
});

describe("useCacheStats", () => {
    it("returns a stable snapshot (no 'getSnapshot should be cached' infinite loop)", async () => {
        const engine: CacheEngine = makeCache();
        let renders = 0;
        function View() {
            renders++;
            const stats = useCacheStats({ engine });
            return createElement("p", { id: "out" }, String(stats?.sets ?? "-"));
        }
        await render(createElement(View));
        expect(renders).toBeLessThan(5);
        await act(async () => engine.set("a", 1));
        await flush();
        expect(container?.querySelector("#out")?.textContent).toBe("1");
        expect(renders).toBeLessThan(20);
    });
});
