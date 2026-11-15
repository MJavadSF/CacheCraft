// ==============================
// CacheCraft DevTools — an in-page management panel.
//
//   import { mountDevtools } from "cache-craft-engine/devtools";
//   if (import.meta.env.DEV) mountDevtools();          // every cache on the page
//
// • Framework-agnostic (vanilla DOM in a Shadow Root: no style leaks either way).
// • Auto-discovers every CacheEngine (devtools !== false) — also across bundles.
// • Overview, entry browser/editor, tags, live activity, storage & maintenance,
//   export/import. No `alert`/`confirm` dialogs; destructive actions need a 2nd click.
// • All text goes through `textContent` — cache keys/values can't inject markup.
// ==============================

import type { CacheEngine } from "../cache-engine";
import { getRegisteredEngines, onRegistryChange } from "../core/registry";
import type {
    CacheEntryMeta,
    CacheEventData,
    DetailedStats,
    HealthStatus,
    StorageInfo,
} from "../types";
import { formatBytes, formatDuration, formatPercentage } from "../utils";
import { STYLES } from "./styles";

export type DevtoolsPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left";

export type DevtoolsOptions = {
    /** Engines to show (default: every registered engine, live). */
    engines?: CacheEngine[];
    /** Corner of the toggle button. Default: `"bottom-right"`. */
    position?: DevtoolsPosition;
    /** Open the panel immediately. Default: false. */
    initialIsOpen?: boolean;
    /** Keyboard shortcut to toggle the panel. Default: `"alt+shift+c"`; `false` to disable. */
    hotkey?: string | false;
    /** Default: `"auto"` (follows `prefers-color-scheme`). */
    theme?: "auto" | "light" | "dark";
    /** Where to attach the panel. Default: `document.body`. */
    container?: HTMLElement;
    /** Hide edit/delete/clear/import actions. Default: false. */
    readOnly?: boolean;
    /** Don't display the decrypted values of encrypted entries. Default: false. */
    maskEncrypted?: boolean;
    /** Rows per page in the entry browser. Default: 100. */
    pageSize?: number;
};

export type DevtoolsHandle = {
    open(): void;
    close(): void;
    toggle(): void;
    /** Select an engine by id. */
    select(engineId: string): void;
    destroy(): void;
};

type Tab = "overview" | "entries" | "tags" | "activity" | "storage";

type Child = Node | string | number | null | undefined | false;

/** Minimal, XSS-safe element builder (text only via textContent). */
function h(
    tag: string,
    attrs: Record<string, string | boolean | number | ((e: Event) => void) | undefined> = {},
    ...children: Child[]
): HTMLElement {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
        if (value === undefined || value === false) continue;
        if (typeof value === "function") el.addEventListener(name.slice(2).toLowerCase(), value);
        else if (value === true) el.setAttribute(name, "");
        else el.setAttribute(name, String(value));
    }
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
}

/** Display-friendly JSON for rich values (Map, Set, Date, BigInt, bytes…). */
export function previewValue(value: unknown): string {
    const seen = new WeakSet<object>();
    const replacer = function (this: unknown, key: string, v: unknown): unknown {
        const raw = (this as Record<string, unknown>)[key];
        if (typeof raw === "bigint") return `${raw}n`;
        if (raw === undefined) return "⟨undefined⟩";
        if (typeof raw === "number" && !Number.isFinite(raw)) return String(raw);
        if (raw instanceof Date)
            return `Date(${Number.isNaN(raw.getTime()) ? "Invalid" : raw.toISOString()})`;
        if (raw instanceof Map) return { "⟨Map⟩": Array.from(raw.entries()) };
        if (raw instanceof Set) return { "⟨Set⟩": Array.from(raw.values()) };
        if (raw instanceof RegExp) return String(raw);
        if (typeof Blob !== "undefined" && raw instanceof Blob)
            return `Blob(${raw.type || "?"}, ${formatBytes(raw.size)})`;
        if (ArrayBuffer.isView(raw)) return `${raw.constructor.name}(${raw.byteLength} bytes)`;
        if (raw instanceof ArrayBuffer) return `ArrayBuffer(${raw.byteLength} bytes)`;
        if (typeof raw === "object" && raw !== null) {
            if (seen.has(raw)) return "⟨circular⟩";
            seen.add(raw);
        }
        return v;
    };
    try {
        return JSON.stringify(value, replacer, 2) ?? String(value);
    } catch {
        return String(value);
    }
}

function relTime(ms: number): string {
    if (ms < 0) return `in ${formatDuration(-ms)}`;
    return `${formatDuration(ms)} ago`;
}

function matchesHotkey(e: KeyboardEvent, spec: string): boolean {
    const parts = spec
        .toLowerCase()
        .split("+")
        .map((p) => p.trim());
    const key = parts[parts.length - 1];
    const want = (m: string): boolean => parts.includes(m);
    return (
        e.altKey === want("alt") &&
        e.shiftKey === want("shift") &&
        (e.ctrlKey || e.metaKey) === (want("ctrl") || want("meta") || want("cmd")) &&
        (e.key.toLowerCase() === key || e.code.toLowerCase() === `key${key}`)
    );
}

function download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: filename }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Mount the panel. Call `destroy()` on the returned handle to remove it. */
export function mountDevtools(options: DevtoolsOptions = {}): DevtoolsHandle {
    if (typeof document === "undefined") {
        const noop = (): void => undefined;
        return { open: noop, close: noop, toggle: noop, select: noop, destroy: noop };
    }

    const pageSize = options.pageSize ?? 100;
    const host = h("div", { "data-cachecraft-devtools": true });
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    root.append(style);
    (options.container ?? document.body).append(host);

    const state = {
        open: options.initialIsOpen ?? false,
        tab: "overview" as Tab,
        engineId: "",
        search: "",
        tag: "",
        showExpired: true,
        page: 0,
        selectedKey: null as string | null,
        activity: [] as Array<CacheEventData & { engine: string }>,
        paused: false,
        armed: "" as string, // id of a destructive button waiting for confirmation
        message: "" as string,
        height: 0,
    };

    const shell = h("div", {
        class: `cc-root cc-${options.position ?? "bottom-right"} cc-theme-${options.theme ?? "auto"}`,
        dir: "ltr",
    });
    root.append(shell);

    const engines = (): CacheEngine[] =>
        (options.engines ?? getRegisteredEngines()).filter((e) => !e.isDestroyed);
    const current = (): CacheEngine | undefined => {
        const list = engines();
        return list.find((e) => e.id === state.engineId) ?? list[0];
    };

    // ---------- live updates ----------
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRender = (): void => {
        if (!state.open || renderTimer !== null) return;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            void render();
        }, 250);
    };

    const subscriptions = new Map<CacheEngine, Array<() => void>>();
    const watch = (): void => {
        const list = engines();
        for (const [engine, offs] of subscriptions) {
            if (!list.includes(engine)) {
                for (const off of offs) off();
                subscriptions.delete(engine);
            }
        }
        for (const engine of list) {
            if (subscriptions.has(engine)) continue;
            const events = [
                "set",
                "delete",
                "clear",
                "evict",
                "expire",
                "hit",
                "miss",
                "sync",
                "error",
            ] as const;
            const offs = events.map((event) =>
                engine.on(event, (data) => {
                    if (!state.paused) {
                        state.activity.unshift({ ...data, engine: engine.info.label });
                        if (state.activity.length > 300) state.activity.length = 300;
                    }
                    if (event === "hit" || event === "miss") {
                        if (state.tab === "overview" || state.tab === "activity") scheduleRender();
                    } else {
                        scheduleRender();
                    }
                })
            );
            subscriptions.set(engine, offs);
        }
    };
    const offRegistry = options.engines
        ? () => undefined
        : onRegistryChange(() => {
              watch();
              scheduleRender();
          });
    watch();

    // ---------- actions ----------
    const flash = (message: string): void => {
        state.message = message;
        void render();
        setTimeout(() => {
            if (state.message === message) {
                state.message = "";
                void render();
            }
        }, 3500);
    };

    const guard = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
        try {
            const result = await fn();
            flash(typeof result === "string" ? result : `${label} ✓`);
        } catch (error) {
            flash(`${label} failed: ${(error as Error).message}`);
        }
    };

    /** A destructive button: first click arms it, second (within 3 s) runs it. */
    const dangerButton = (id: string, label: string, run: () => Promise<unknown>): HTMLElement => {
        const armed = state.armed === id;
        return h(
            "button",
            {
                class: `cc-btn cc-danger${armed ? " cc-armed" : ""}`,
                onclick: () => {
                    if (state.armed !== id) {
                        state.armed = id;
                        void render();
                        setTimeout(() => {
                            if (state.armed === id) {
                                state.armed = "";
                                void render();
                            }
                        }, 3000);
                        return;
                    }
                    state.armed = "";
                    void guard(label, run);
                },
            },
            armed ? `Click again to ${label.toLowerCase()}` : label
        );
    };

    const button = (label: string, onclick: () => void, extra = ""): HTMLElement =>
        h("button", { class: `cc-btn ${extra}`, onclick }, label);

    // ---------- views ----------
    const card = (label: string, value: string, hint?: string): HTMLElement =>
        h(
            "div",
            { class: "cc-card" },
            h("div", { class: "cc-card-label" }, label),
            h("div", { class: "cc-card-value" }, value),
            hint ? h("div", { class: "cc-card-hint" }, hint) : null
        );

    async function overview(engine: CacheEngine): Promise<HTMLElement> {
        const [stats, health]: [DetailedStats, HealthStatus] = await Promise.all([
            engine.getDetailedStats(),
            engine.getHealth(),
        ]);
        const get = stats.latency.get;
        const set = stats.latency.set;
        const cards = h(
            "div",
            { class: "cc-cards" },
            card(
                "Entries",
                String(stats.entryCount),
                stats.expiredCount ? `${stats.expiredCount} expired` : undefined
            ),
            card(
                "Size",
                formatBytes(stats.totalSize),
                stats.compressionRatio
                    ? `compressed to ${formatPercentage(stats.compressionRatio)}`
                    : undefined
            ),
            card(
                "Hit rate",
                formatPercentage(stats.hitRate),
                `${stats.hits} hits · ${stats.misses} misses`
            ),
            card("Memory tier", String(stats.memoryEntries), `${stats.memoryHits} memory hits`),
            card(
                "get p50 / p95",
                get ? `${get.p50.toFixed(1)} / ${get.p95.toFixed(1)} ms` : "—",
                get ? `${get.count} calls` : undefined
            ),
            card(
                "set p50 / p95",
                set ? `${set.p50.toFixed(1)} / ${set.p95.toFixed(1)} ms` : "—",
                set ? `${set.count} calls` : undefined
            ),
            card("Evictions", String(stats.evictions)),
            card("Errors", String(stats.errors), health.lastError?.message)
        );
        const healthBox = h(
            "div",
            { class: `cc-health ${health.isHealthy ? "cc-ok" : "cc-warn"}` },
            h("strong", {}, health.isHealthy ? "Healthy" : "Needs attention"),
            ...health.issues.map((i) => h("div", {}, `• ${i}`))
        );
        const actions = h(
            "div",
            { class: "cc-actions" },
            button(
                "Clean up expired",
                () =>
                    void guard(
                        "Cleanup",
                        async () => `Removed ${await engine.cleanup()} expired entries`
                    )
            ),
            button(
                "Flush access metadata",
                () => void guard("Flush", () => engine.flushAccessMetadata())
            ),
            button("Reload index", () => void guard("Reload", () => engine.refresh())),
            button("Reset stats", () => {
                engine.resetStats();
                void render();
            }),
            button(
                "Export JSON",
                () =>
                    void guard("Export", async () => {
                        download(
                            await engine.exportBlob(),
                            `cachecraft-${engine.info.dbName}-${engine.info.namespace || "root"}.json`
                        );
                        return "Exported";
                    })
            ),
            options.readOnly ? null : importButton(engine),
            options.readOnly
                ? null
                : dangerButton(
                      `clear:${engine.id}`,
                      "Clear namespace",
                      async () => `Removed ${await engine.clear()} entries`
                  )
        );
        return h("div", { class: "cc-view" }, healthBox, cards, actions);
    }

    function importButton(engine: CacheEngine): HTMLElement {
        const input = h("input", {
            type: "file",
            accept: "application/json,.json",
            class: "cc-hidden",
        }) as HTMLInputElement;
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            if (file)
                void guard(
                    "Import",
                    async () =>
                        `Imported ${await engine.importBlob(file, { overwrite: true })} entries`
                );
        });
        return h("label", { class: "cc-btn" }, "Import JSON…", input);
    }

    async function entries(engine: CacheEngine): Promise<HTMLElement> {
        let pattern: RegExp | string | undefined = state.search || undefined;
        const asRegex = /^\/(.+)\/([a-z]*)$/.exec(state.search);
        if (asRegex) {
            try {
                pattern = new RegExp(asRegex[1] as string, asRegex[2]);
            } catch {
                pattern = state.search;
            }
        }
        const all = await engine.queryMeta({
            ...(pattern ? { pattern } : {}),
            ...(state.tag ? { tags: [state.tag] } : {}),
            ...(state.showExpired ? {} : { expired: false }),
            sortBy: "lastAccessed",
            sortOrder: "desc",
        });
        const pages = Math.max(Math.ceil(all.length / pageSize), 1);
        state.page = Math.min(state.page, pages - 1);
        const rows = all.slice(state.page * pageSize, (state.page + 1) * pageSize);
        const nowMs = Date.now();

        const search = h("input", {
            class: "cc-input",
            placeholder: "Filter keys (text or /regex/)",
            value: state.search,
        }) as HTMLInputElement;
        search.addEventListener("input", () => {
            state.search = search.value;
            state.page = 0;
            void render().then(() => {
                const again = root.querySelector<HTMLInputElement>(".cc-input");
                again?.focus();
                again?.setSelectionRange(again.value.length, again.value.length);
            });
        });
        const tagSelect = h(
            "select",
            { class: "cc-select" },
            h("option", { value: "" }, "All tags"),
            ...engine
                .allTags()
                .sort()
                .map((t) => h("option", { value: t, selected: t === state.tag }, t))
        ) as HTMLSelectElement;
        tagSelect.addEventListener("change", () => {
            state.tag = tagSelect.value;
            state.page = 0;
            void render();
        });
        const expired = h("input", {
            type: "checkbox",
            checked: state.showExpired,
        }) as HTMLInputElement;
        expired.addEventListener("change", () => {
            state.showExpired = expired.checked;
            void render();
        });

        const table = h(
            "table",
            { class: "cc-table" },
            h(
                "thead",
                {},
                h(
                    "tr",
                    {},
                    ...["Key", "Size", "Age", "Expires", "Hits", "Tags", ""].map((c) =>
                        h("th", {}, c)
                    )
                )
            ),
            h(
                "tbody",
                {},
                ...rows.map((m) => {
                    const expiredRow = m.expiresAt !== undefined && m.expiresAt < nowMs;
                    return h(
                        "tr",
                        {
                            class: `${m.key === state.selectedKey ? "cc-selected" : ""} ${expiredRow ? "cc-expired" : ""}`,
                            onclick: () => {
                                state.selectedKey = m.key;
                                void render();
                            },
                        },
                        h("td", { class: "cc-key", title: m.key }, m.key),
                        h("td", {}, formatBytes(m.size)),
                        h("td", {}, formatDuration(nowMs - m.createdAt)),
                        h(
                            "td",
                            {},
                            m.expiresAt === undefined ? "never" : relTime(nowMs - m.expiresAt)
                        ),
                        h("td", {}, String(m.accessCount)),
                        h("td", {}, (m.tags ?? []).join(", ")),
                        h(
                            "td",
                            { class: "cc-flags" },
                            `${m.isEncrypted ? "🔒" : ""}${m.isCompressed ? "🗜" : ""}${m.kind === "blob" ? "📦" : ""}`
                        )
                    );
                })
            )
        );
        const pager = h(
            "div",
            { class: "cc-pager" },
            `${all.length} entries`,
            button("‹", () => {
                state.page = Math.max(state.page - 1, 0);
                void render();
            }),
            `${state.page + 1} / ${pages}`,
            button("›", () => {
                state.page = Math.min(state.page + 1, pages - 1);
                void render();
            })
        );
        const toolbar = h(
            "div",
            { class: "cc-toolbar" },
            search,
            tagSelect,
            h("label", { class: "cc-check" }, expired, " show expired"),
            pager
        );
        const selected = all.find((m) => m.key === state.selectedKey);
        const detail = selected
            ? await entryDetail(engine, selected)
            : h("div", { class: "cc-detail cc-muted" }, "Select an entry to inspect it.");
        return h(
            "div",
            { class: "cc-view" },
            toolbar,
            h("div", { class: "cc-split" }, h("div", { class: "cc-table-wrap" }, table), detail)
        );
    }

    async function entryDetail(engine: CacheEngine, m: CacheEntryMeta): Promise<HTMLElement> {
        let valueText: string;
        let editable = false;
        if (m.isEncrypted && options.maskEncrypted) {
            valueText = "⟨encrypted — hidden by maskEncrypted⟩";
        } else if (m.kind === "blob") {
            const blob = await engine.getBlob(m.key).catch(() => null);
            valueText = blob ? previewValue(blob) : "⟨unavailable⟩";
        } else {
            try {
                const value = await engine.peek(m.key, { allowStale: true });
                valueText = previewValue(value);
                editable = !options.readOnly;
            } catch (error) {
                valueText = `⟨cannot decode: ${(error as Error).message}⟩`;
            }
        }
        const { key: _key, ...metaRest } = m;
        const editor = h("textarea", {
            class: "cc-editor",
            spellcheck: "false",
            readonly: !editable,
        }) as HTMLTextAreaElement;
        editor.value = valueText;
        const ttlInput = h("input", {
            class: "cc-input cc-small",
            placeholder: "e.g. 5m, 1h",
        }) as HTMLInputElement;
        return h(
            "div",
            { class: "cc-detail" },
            h("div", { class: "cc-detail-key" }, m.key),
            h("pre", { class: "cc-meta" }, previewValue(metaRest)),
            editor,
            h(
                "div",
                { class: "cc-actions" },
                editable
                    ? button(
                          "Save value (JSON)",
                          () =>
                              void guard("Save", async () => {
                                  const parsed: unknown = JSON.parse(editor.value);
                                  const remaining =
                                      m.expiresAt === undefined
                                          ? undefined
                                          : Math.max(m.expiresAt - Date.now(), 1);
                                  await engine.set(m.key, parsed, {
                                      ...(remaining !== undefined ? { ttl: remaining } : {}),
                                      ...(m.tags?.length ? { tags: m.tags } : {}),
                                      ...(m.priority !== undefined ? { priority: m.priority } : {}),
                                      ...(m.metadata ? { metadata: m.metadata } : {}),
                                      encrypt: m.isEncrypted,
                                  });
                              })
                      )
                    : null,
                options.readOnly ? null : ttlInput,
                options.readOnly
                    ? null
                    : button(
                          "Set TTL",
                          () =>
                              void guard("TTL", async () => {
                                  const ok = await engine.touch(
                                      m.key,
                                      ttlInput.value.trim() || undefined
                                  );
                                  return ok ? "TTL updated" : "Entry is gone";
                              })
                      ),
                options.readOnly
                    ? null
                    : button("No expiry", () => void guard("TTL", () => engine.touch(m.key, null))),
                options.readOnly
                    ? null
                    : dangerButton(`del:${engine.id}:${m.key}`, "Delete", async () => {
                          await engine.remove(m.key);
                          state.selectedKey = null;
                      })
            )
        );
    }

    async function tags(engine: CacheEngine): Promise<HTMLElement> {
        const stats = await engine.getDetailedStats();
        const names = Object.keys(stats.entriesByTag).sort(
            (a, b) => (stats.entriesByTag[b] ?? 0) - (stats.entriesByTag[a] ?? 0)
        );
        if (names.length === 0)
            return h("div", { class: "cc-view cc-muted" }, "No tagged entries.");
        return h(
            "div",
            { class: "cc-view" },
            h(
                "table",
                { class: "cc-table" },
                h(
                    "thead",
                    {},
                    h(
                        "tr",
                        {},
                        h("th", {}, "Tag"),
                        h("th", {}, "Entries"),
                        h("th", {}, "Size"),
                        h("th", {}, "")
                    )
                ),
                h(
                    "tbody",
                    {},
                    ...names.map((tag) =>
                        h(
                            "tr",
                            {},
                            h("td", { class: "cc-key" }, tag),
                            h("td", {}, String(stats.entriesByTag[tag] ?? 0)),
                            h("td", {}, formatBytes(stats.sizeByTag[tag] ?? 0)),
                            h(
                                "td",
                                {},
                                button("Show", () => {
                                    state.tag = tag;
                                    state.tab = "entries";
                                    void render();
                                }),
                                options.readOnly
                                    ? null
                                    : dangerButton(
                                          `tag:${engine.id}:${tag}`,
                                          "Invalidate",
                                          async () =>
                                              `Removed ${await engine.invalidateByTag(tag)} entries`
                                      )
                            )
                        )
                    )
                )
            )
        );
    }

    function activity(): HTMLElement {
        const list = state.activity.slice(0, 200);
        return h(
            "div",
            { class: "cc-view" },
            h(
                "div",
                { class: "cc-toolbar" },
                button(state.paused ? "Resume" : "Pause", () => {
                    state.paused = !state.paused;
                    void render();
                }),
                button("Clear log", () => {
                    state.activity = [];
                    void render();
                }),
                h("span", { class: "cc-muted" }, `${state.activity.length} events (all caches)`)
            ),
            h(
                "div",
                { class: "cc-log" },
                ...list.map((a) =>
                    h(
                        "div",
                        { class: `cc-log-row cc-ev-${a.event}` },
                        h(
                            "span",
                            { class: "cc-muted" },
                            new Date(a.timestamp).toLocaleTimeString()
                        ),
                        h("span", { class: "cc-ev" }, a.event),
                        h(
                            "span",
                            { class: "cc-key" },
                            a.key ??
                                (a.metadata ? previewValue(a.metadata).replace(/\s+/g, " ") : "")
                        ),
                        h("span", { class: "cc-muted" }, a.engine),
                        a.error ? h("span", { class: "cc-error" }, a.error.message) : null
                    )
                )
            )
        );
    }

    async function storage(engine: CacheEngine): Promise<HTMLElement> {
        const info: StorageInfo = await engine.getStorageInfo();
        const e = engine.info;
        const pct = Math.min(info.percentage * 100, 100);
        return h(
            "div",
            { class: "cc-view" },
            h(
                "div",
                { class: "cc-cards" },
                card("Backend", e.storage, e.persistent ? "persistent" : "in-memory"),
                card("Database / store", `${e.dbName} / ${e.storeName}`),
                card("Namespace", e.namespace || "(root)"),
                card(
                    "Origin usage",
                    formatBytes(info.used),
                    info.total ? `of ${formatBytes(info.total)}` : undefined
                ),
                card("Persistent storage", info.persisted ? "granted" : "not granted")
            ),
            h(
                "div",
                { class: "cc-bar" },
                h("div", { class: "cc-bar-fill", style: `width:${pct.toFixed(1)}%` })
            ),
            h(
                "div",
                { class: "cc-actions" },
                info.persisted
                    ? null
                    : button(
                          "Request persistent storage",
                          () =>
                              void guard("Persistence", async () =>
                                  (await engine.requestPersistence())
                                      ? "Persistent storage granted"
                                      : "Not granted by the browser"
                              )
                      ),
                options.readOnly
                    ? null
                    : button(
                          "Migrate ≤0.5 data",
                          () =>
                              void guard(
                                  "Migration",
                                  async () => `Migrated ${await engine.migrateLegacy()} entries`
                              )
                      ),
                options.readOnly
                    ? null
                    : dangerButton(
                          `legacy:${engine.id}`,
                          "Drop ≤0.5 data",
                          async () => `Dropped ${await engine.dropLegacyData()} legacy entries`
                      )
            )
        );
    }

    // ---------- shell ----------
    let rendering = false;
    let rerender = false;
    async function render(): Promise<void> {
        if (rendering) {
            rerender = true;
            return;
        }
        rendering = true;
        try {
            shell.replaceChildren();
            const toggle = h(
                "button",
                {
                    class: "cc-toggle",
                    title: "CacheCraft DevTools",
                    onclick: () => handle.toggle(),
                },
                "⚡ Cache"
            );
            if (!state.open) {
                shell.append(toggle);
                return;
            }
            const list = engines();
            const engine = current();
            if (engine) state.engineId = engine.id;

            const select = h(
                "select",
                { class: "cc-select" },
                ...list.map((e) =>
                    h("option", { value: e.id, selected: e.id === state.engineId }, e.info.label)
                )
            ) as HTMLSelectElement;
            select.addEventListener("change", () => handle.select(select.value));

            const tabs = (["overview", "entries", "tags", "activity", "storage"] as Tab[]).map(
                (t) =>
                    h(
                        "button",
                        {
                            class: `cc-tab${state.tab === t ? " cc-active" : ""}`,
                            onclick: () => {
                                state.tab = t;
                                void render();
                            },
                        },
                        t[0]?.toUpperCase() + t.slice(1)
                    )
            );

            let body: HTMLElement;
            if (!engine) {
                body = h(
                    "div",
                    { class: "cc-view cc-muted" },
                    "No caches yet. Engines appear here as soon as they are created (unless `devtools: false`)."
                );
            } else {
                try {
                    body =
                        state.tab === "overview"
                            ? await overview(engine)
                            : state.tab === "entries"
                              ? await entries(engine)
                              : state.tab === "tags"
                                ? await tags(engine)
                                : state.tab === "activity"
                                  ? activity()
                                  : await storage(engine);
                } catch (error) {
                    body = h(
                        "div",
                        { class: "cc-view cc-error" },
                        `Could not read the cache: ${(error as Error).message}`
                    );
                }
            }

            const resizer = h("div", { class: "cc-resizer", title: "Drag to resize" });
            resizer.addEventListener("pointerdown", (down) => {
                const start = (down as PointerEvent).clientY;
                const panel = root.querySelector<HTMLElement>(".cc-panel");
                const startHeight = panel?.getBoundingClientRect().height ?? 320;
                const move = (e: PointerEvent): void => {
                    state.height = Math.min(
                        Math.max(startHeight + (start - e.clientY), 160),
                        window.innerHeight - 40
                    );
                    if (panel) panel.style.height = `${state.height}px`;
                };
                const up = (): void => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
            });

            const panel = h(
                "div",
                {
                    class: "cc-panel",
                    role: "dialog",
                    "aria-label": "CacheCraft DevTools",
                    style: state.height ? `height:${state.height}px` : undefined,
                },
                resizer,
                h(
                    "header",
                    { class: "cc-header" },
                    h("span", { class: "cc-title" }, "⚡ CacheCraft"),
                    list.length ? select : null,
                    h("nav", { class: "cc-tabs" }, ...tabs),
                    h("span", { class: "cc-spacer" }),
                    state.message ? h("span", { class: "cc-message" }, state.message) : null,
                    button("↻", () => void render(), "cc-icon"),
                    button("✕", () => handle.close(), "cc-icon")
                ),
                body
            );
            shell.append(panel);
        } finally {
            rendering = false;
            if (rerender) {
                rerender = false;
                void render();
            }
        }
    }

    const onKey = (e: KeyboardEvent): void => {
        if (options.hotkey === false) return;
        if (matchesHotkey(e, options.hotkey ?? "alt+shift+c")) {
            e.preventDefault();
            handle.toggle();
        }
    };
    window.addEventListener("keydown", onKey);

    const handle: DevtoolsHandle = {
        open() {
            state.open = true;
            void render();
        },
        close() {
            state.open = false;
            void render();
        },
        toggle() {
            state.open = !state.open;
            void render();
        },
        select(engineId: string) {
            state.engineId = engineId;
            state.selectedKey = null;
            state.page = 0;
            state.tag = "";
            void render();
        },
        destroy() {
            window.removeEventListener("keydown", onKey);
            offRegistry();
            for (const offs of subscriptions.values()) for (const off of offs) off();
            subscriptions.clear();
            if (renderTimer !== null) clearTimeout(renderTimer);
            host.remove();
        },
    };

    void render();
    return handle;
}
