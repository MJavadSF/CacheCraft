// ==============================
// Locks
//
// • KeyedMutex — serialises async work per key inside one JS realm.
// • withWebLock — the same across tabs/workers of an origin (Web Locks API),
//   degrading to the in-realm mutex where the API is missing.
// ==============================

type LockManagerLike = {
    request<T>(
        name: string,
        options: { mode?: "exclusive" | "shared"; ifAvailable?: boolean; signal?: AbortSignal },
        callback: (lock: unknown) => Promise<T> | T
    ): Promise<T>;
};

export function getLockManager(): LockManagerLike | undefined {
    if (typeof navigator === "undefined") return undefined;
    const locks = (navigator as { locks?: LockManagerLike }).locks;
    return locks && typeof locks.request === "function" ? locks : undefined;
}

export function isWebLocksSupported(): boolean {
    return getLockManager() !== undefined;
}

export class KeyedMutex {
    private readonly tails = new Map<string, Promise<void>>();

    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => current);
        this.tails.set(key, tail);
        await previous;
        try {
            return await fn();
        } finally {
            release();
            if (this.tails.get(key) === tail) this.tails.delete(key);
        }
    }
}

const localMutex = new KeyedMutex();

/**
 * Run `fn` while holding the lock `name` (cross-tab when possible). `"shared"` locks
 * can be held by many readers at once but never together with an exclusive one.
 * Without Web Locks, exclusive locks fall back to an in-realm mutex and shared
 * locks don't wait.
 */
export function withWebLock<T>(
    name: string,
    fn: () => Promise<T>,
    options: { signal?: AbortSignal | undefined; mode?: "exclusive" | "shared" } = {}
): Promise<T> {
    const locks = getLockManager();
    const mode = options.mode ?? "exclusive";
    if (!locks) return mode === "shared" ? fn() : localMutex.run(name, fn);
    return locks.request(
        name,
        { mode, ...(options.signal ? { signal: options.signal } : {}) },
        () => fn()
    );
}

/**
 * Become the leader for `name`: `onLeader` runs once this context holds the lock,
 * which it keeps until `release()` is called (or the tab goes away). Without Web
 * Locks every context is its own leader.
 */
export function acquireLeadership(name: string, onLeader: () => void): () => void {
    const locks = getLockManager();
    if (!locks) {
        onLeader();
        return () => undefined;
    }
    let releaseLock!: () => void;
    const held = new Promise<void>((resolve) => {
        releaseLock = resolve;
    });
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    locks
        .request(name, controller ? { signal: controller.signal } : {}, async () => {
            onLeader();
            await held;
        })
        .catch(() => undefined);
    return () => {
        releaseLock();
        controller?.abort();
    };
}
