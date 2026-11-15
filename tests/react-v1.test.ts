import { act, Component, createElement, type ReactElement, type ReactNode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
    CacheProvider,
    disposeSharedCaches,
    getSharedCache,
    prefetchCache,
    type UseCacheState,
    useCache,
    useCacheDevtools,
    useSuspenseCache,
} from "../src/react";
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

const text = (id: string): string | null | undefined =>
    container?.querySelector(`#${id}`)?.textContent;

afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    for (const n of document.querySelectorAll("[data-cachecraft-devtools]")) n.remove();
    await disposeSharedCaches();
    await destroyAll();
});

describe("CacheProvider", () => {
    it("supplies the engine to hooks below it", async () => {
        const engine = makeCache();
        await engine.set("k", "from-provider");
        function View() {
            const { data } = useCache("k", () => "factory");
            return createElement("p", { id: "out" }, String(data));
        }
        await render(createElement(CacheProvider, { engine }, createElement(View)));
        await flush();
        expect(text("out")).toBe("from-provider");
    });
});

describe("useCache v1", () => {
    it("keeps hooks on the same key in sync after mutate()", async () => {
        const engine = makeCache();
        let api: UseCacheState<number> | null = null;
        function A() {
            const s = useCache("n", () => 1, { engine });
            api = s;
            return createElement("p", { id: "a" }, String(s.data));
        }
        function B() {
            const { data } = useCache("n", () => 1, { engine });
            return createElement("p", { id: "b" }, String(data));
        }
        await render(createElement("div", null, createElement(A), createElement(B)));
        await flush();
        await act(async () => {
            await api?.mutate((n) => (n ?? 0) + 41);
        });
        expect(text("a")).toBe("42");
        expect(text("b")).toBe("42");
    });

    it("rolls back an optimistic mutate when the write fails", async () => {
        const engine = makeCache();
        let api: UseCacheState<{ n: number }> | null = null;
        function View() {
            api = useCache("k", () => ({ n: 1 }), { engine });
            return createElement("p", { id: "out" }, JSON.stringify(api.data));
        }
        await render(createElement(View));
        await flush();
        vi.spyOn(engine, "set").mockRejectedValueOnce(new Error("quota"));
        await act(async () => {
            await api?.mutate({ n: 2 }).catch(() => undefined);
        });
        expect(text("out")).toBe('{"n":1}');
        expect((api as UseCacheState<{ n: number }> | null)?.error?.message).toBe("quota");
    });

    it("shows fallbackData until the first result and refetches after invalidate()", async () => {
        const engine = makeCache();
        let calls = 0;
        let api: UseCacheState<string> | null = null;
        function View() {
            api = useCache(
                "k",
                async () => {
                    calls++;
                    await sleep(10);
                    return `v${calls}`;
                },
                { engine, fallbackData: "fallback" }
            );
            return createElement("p", { id: "out" }, `${api.data}|${api.isLoading}`);
        }
        await render(createElement(View));
        expect(text("out")).toBe("fallback|false");
        await flush();
        expect(text("out")).toBe("v1|false");
        await act(async () => {
            await api?.invalidate();
        });
        await flush();
        expect(text("out")).toBe("v2|false");
    });

    it("refreshInterval revalidates periodically", async () => {
        const engine = makeCache();
        let calls = 0;
        function View() {
            const { data } = useCache("k", () => ++calls, { engine, refreshInterval: 20 });
            return createElement("p", { id: "out" }, String(data));
        }
        await render(createElement(View));
        await flush(75);
        expect(calls).toBeGreaterThanOrEqual(3);
    });

    it("keepPreviousData shows the old key's data while the new one loads", async () => {
        const engine = makeCache();
        let setKey: (k: string) => void = () => undefined;
        const { useState } = await import("react");
        function View() {
            const [key, set] = useState("a");
            setKey = set;
            const { data } = useCache(
                key,
                async () => {
                    await sleep(20);
                    return key;
                },
                { engine, keepPreviousData: true }
            );
            return createElement("p", { id: "out" }, String(data));
        }
        await render(createElement(View));
        await flush(40);
        expect(text("out")).toBe("a");
        await act(async () => setKey("b"));
        expect(text("out")).toBe("a");
        await flush(40);
        expect(text("out")).toBe("b");
    });
});

class Boundary extends Component<{ children?: ReactNode }, { error: Error | null }> {
    override state = { error: null as Error | null };
    static getDerivedStateFromError(error: Error) {
        return { error };
    }
    override render() {
        return this.state.error
            ? createElement("p", { id: "err" }, this.state.error.message)
            : this.props.children;
    }
}

describe("Suspense", () => {
    it("suspends until the value is ready", async () => {
        const engine = makeCache();
        function View() {
            const { data } = useSuspenseCache(
                "s",
                async () => {
                    await sleep(10);
                    return "ready";
                },
                { engine }
            );
            return createElement("p", { id: "out" }, data);
        }
        await render(
            createElement(
                Suspense,
                { fallback: createElement("p", { id: "out" }, "loading") },
                createElement(View)
            )
        );
        expect(text("out")).toBe("loading");
        await flush(40);
        expect(text("out")).toBe("ready");
        await act(async () => {
            await engine.set("s", "updated");
        });
        expect(text("out")).toBe("updated");
    });

    it("sends errors to the error boundary", async () => {
        const engine = makeCache();
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        function View() {
            useSuspenseCache(
                "e",
                async () => {
                    throw new Error("boom");
                },
                { engine }
            );
            return null;
        }
        await render(
            createElement(
                Boundary,
                null,
                createElement(Suspense, { fallback: null }, createElement(View))
            )
        );
        await flush(30);
        expect(text("err")).toBe("boom");
        spy.mockRestore();
    });

    it("prefetchCache warms the cache", async () => {
        const engine = makeCache();
        await prefetchCache(engine, "p", () => 7);
        expect(await engine.get("p")).toBe(7);
    });
});

describe("shared engines", () => {
    it("warns when the same identity is requested with a different config", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const a = getSharedCache({ dbName: "shared-x", maxSize: 1000 });
        const b = getSharedCache({ dbName: "shared-x", maxSize: 2000 });
        expect(a).toBe(b);
        expect(warn).toHaveBeenCalledOnce();
        warn.mockRestore();
    });
});

describe("useCacheDevtools", () => {
    it("mounts the panel lazily and removes it on unmount", async () => {
        makeCache();
        function View() {
            useCacheDevtools({ enabled: true });
            return null;
        }
        await render(createElement(View));
        await flush(50);
        expect(document.querySelector("[data-cachecraft-devtools]")).not.toBeNull();
        await act(async () => root?.unmount());
        root = null;
        expect(document.querySelector("[data-cachecraft-devtools]")).toBeNull();
    });
});
