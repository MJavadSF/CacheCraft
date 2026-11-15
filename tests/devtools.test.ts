import { afterEach, describe, expect, it } from "vitest";
import { mountDevtools, previewValue } from "../src/devtools";
import { destroyAll, makeCache, sleep } from "./helpers";

afterEach(async () => {
    for (const n of document.querySelectorAll("[data-cachecraft-devtools]")) n.remove();
    await destroyAll();
});

function shadow(): ShadowRoot {
    const host = document.querySelector("[data-cachecraft-devtools]");
    if (!host?.shadowRoot) throw new Error("devtools not mounted");
    return host.shadowRoot;
}

function click(label: string): void {
    const button = [...shadow().querySelectorAll("button")].find((b) =>
        b.textContent?.startsWith(label)
    );
    if (!button) throw new Error(`No button "${label}"`);
    button.click();
}

const settle = () => sleep(40);

describe("devtools panel", () => {
    it("discovers engines and shows an overview", async () => {
        const cache = makeCache({ label: "Products cache" });
        await cache.set("a", 1, { tags: ["t"] });
        await cache.get("a");
        const devtools = mountDevtools({ initialIsOpen: true });
        await settle();
        const text = shadow().textContent ?? "";
        expect(text).toContain("Products cache");
        expect(text).toContain("Hit rate");
        expect(text).toContain("100.00%");
        devtools.destroy();
        expect(document.querySelector("[data-cachecraft-devtools]")).toBeNull();
    });

    it("browses, inspects, edits and deletes entries", async () => {
        const cache = makeCache();
        await cache.set("user:1", { name: "Ada", born: new Date(0) }, { tags: ["users"] });
        await cache.set("other", 2);
        const devtools = mountDevtools({ engines: [cache], initialIsOpen: true });
        await settle();
        click("Entries");
        await settle();
        const rows = shadow().querySelectorAll("tbody tr");
        expect(rows).toHaveLength(2);
        const row = [...rows].find((r) => r.textContent?.includes("user:1")) as HTMLElement;
        row.click();
        await settle();
        const editor = shadow().querySelector("textarea") as HTMLTextAreaElement;
        expect(editor.value).toContain("Ada");
        expect(editor.value).toContain("Date(1970-01-01T00:00:00.000Z)");

        editor.value = JSON.stringify({ name: "Grace" });
        click("Save value");
        await settle();
        expect(await cache.get("user:1")).toEqual({ name: "Grace" });
        expect(await cache.keysByTag("users")).toEqual(["user:1"]); // tags kept

        click("Delete"); // arms
        await settle();
        click("Click again");
        await settle();
        expect(await cache.has("user:1")).toBe(false);
        devtools.destroy();
    });

    it("filters by text/regex and never injects markup from keys", async () => {
        const cache = makeCache();
        await cache.set("<img src=x onerror=alert(1)>", 1);
        await cache.set("plain", 1);
        const devtools = mountDevtools({ engines: [cache], initialIsOpen: true });
        await settle();
        click("Entries");
        await settle();
        expect(shadow().querySelector("img")).toBeNull();
        const input = shadow().querySelector(".cc-input") as HTMLInputElement;
        input.value = "/^pl/";
        input.dispatchEvent(new Event("input"));
        await settle();
        expect(shadow().querySelectorAll("tbody tr")).toHaveLength(1);
        devtools.destroy();
    });

    it("invalidates tags, clears with confirmation, and respects readOnly", async () => {
        const cache = makeCache();
        await cache.set("a", 1, { tags: ["t"] });
        await cache.set("b", 1);
        const devtools = mountDevtools({ engines: [cache], initialIsOpen: true });
        await settle();
        click("Tags");
        await settle();
        click("Invalidate");
        await settle();
        click("Click again");
        await settle();
        expect(await cache.keys()).toEqual(["b"]);
        click("Overview");
        await settle();
        click("Clear namespace");
        await settle();
        expect(await cache.count()).toBe(1); // not yet — needs the second click
        click("Click again");
        await settle();
        expect(await cache.count()).toBe(0);
        devtools.destroy();

        const ro = mountDevtools({ engines: [cache], initialIsOpen: true, readOnly: true });
        await settle();
        expect(shadow().textContent).not.toContain("Clear namespace");
        ro.destroy();
    });

    it("logs activity, masks encrypted values on request and toggles with the hotkey", async () => {
        const cache = makeCache({ encryptionKey: "pw", kdfIterations: 1000 });
        const devtools = mountDevtools({ engines: [cache], maskEncrypted: true });
        await cache.set("secret", "hunter2", { encrypt: true });
        window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "c", code: "KeyC", altKey: true, shiftKey: true })
        );
        await settle();
        click("Activity");
        await settle();
        expect(shadow().textContent).toContain("secret");
        click("Entries");
        await settle();
        (shadow().querySelector("tbody tr") as HTMLElement).click();
        await settle();
        expect((shadow().querySelector("textarea") as HTMLTextAreaElement).value).toContain(
            "hidden"
        );
        devtools.destroy();
    });

    it("previews rich values", () => {
        const text = previewValue({
            m: new Map([[1, 2]]),
            s: new Set([1]),
            b: 5n,
            u: undefined,
            bytes: new Uint8Array(3),
        });
        expect(text).toContain("⟨Map⟩");
        expect(text).toContain("5n");
        expect(text).toContain("Uint8Array(3 bytes)");
    });
});
