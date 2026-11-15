import type { CacheEngine } from "../cache-engine";
import type { CacheEvent, CacheEventData } from "../types";

// ==============================
// OpenTelemetry metrics — structurally typed against @opentelemetry/api's Meter,
// so there is no dependency:
//
//   import { metrics } from "@opentelemetry/api";
//   const stop = instrumentOpenTelemetry(cache, { meter: metrics.getMeter("app") });
// ==============================

type Attributes = Record<string, string | number | boolean>;

type ObservableCallback = (result: {
    observe(value: number, attributes?: Attributes): void;
}) => void;

export interface MeterLike {
    createCounter(
        name: string,
        options?: { description?: string; unit?: string }
    ): {
        add(value: number, attributes?: Attributes): void;
    };
    createHistogram(
        name: string,
        options?: { description?: string; unit?: string }
    ): {
        record(value: number, attributes?: Attributes): void;
    };
    createObservableGauge?(
        name: string,
        options?: { description?: string; unit?: string }
    ): {
        addCallback(callback: ObservableCallback): void;
        removeCallback?(callback: ObservableCallback): void;
    };
}

export type OpenTelemetryOptions = {
    meter: MeterLike;
    /** Metric name prefix. Default: `"cachecraft"`. */
    prefix?: string;
    /** Extra attributes on every data point. */
    attributes?: Attributes;
};

/** Export cache metrics. Returns a function that stops the instrumentation. */
export function instrumentOpenTelemetry(
    engine: CacheEngine,
    options: OpenTelemetryOptions
): () => void {
    const { meter } = options;
    const p = options.prefix ?? "cachecraft";
    const base: Attributes = {
        "cache.db": engine.info.dbName,
        "cache.store": engine.info.storeName,
        "cache.namespace": engine.info.namespace,
        ...options.attributes,
    };

    const counters: Partial<Record<CacheEvent, ReturnType<MeterLike["createCounter"]>>> = {
        hit: meter.createCounter(`${p}.hits`, { description: "Cache hits" }),
        miss: meter.createCounter(`${p}.misses`, { description: "Cache misses" }),
        set: meter.createCounter(`${p}.sets`, { description: "Cache writes" }),
        delete: meter.createCounter(`${p}.deletes`, { description: "Cache deletions" }),
        expire: meter.createCounter(`${p}.expirations`, { description: "Expired entries removed" }),
        error: meter.createCounter(`${p}.errors`, { description: "Cache errors" }),
    };
    const evictions = meter.createCounter(`${p}.evictions`, { description: "Evicted entries" });
    const duration = meter.createHistogram(`${p}.operation.duration`, {
        description: "Duration of cache operations",
        unit: "ms",
    });

    const offs: Array<() => void> = [];
    for (const [event, counter] of Object.entries(counters) as Array<
        [CacheEvent, ReturnType<MeterLike["createCounter"]>]
    >) {
        offs.push(
            engine.on(event, (data: CacheEventData) => {
                const attrs =
                    event === "error" && data.metadata?.operation
                        ? { ...base, "cache.operation": String(data.metadata.operation) }
                        : base;
                counter.add(1, attrs);
            })
        );
    }
    offs.push(
        engine.on("evict", (data) => {
            evictions.add(Number(data.metadata?.count ?? 1), {
                ...base,
                "cache.evict.reason": String(data.metadata?.reason ?? "budget"),
            });
        })
    );
    offs.push(
        engine.on("operation", (data) => {
            const m = data.metadata as
                | { operation: string; duration: number; success: boolean }
                | undefined;
            if (!m) return;
            duration.record(m.duration, {
                ...base,
                "cache.operation": m.operation,
                "cache.success": m.success,
            });
        })
    );

    if (meter.createObservableGauge) {
        const size = meter.createObservableGauge(`${p}.size`, {
            description: "Stored bytes",
            unit: "By",
        });
        const entries = meter.createObservableGauge(`${p}.entries`, {
            description: "Stored entries",
        });
        const observeSize = (r: { observe(v: number, a?: Attributes): void }): void =>
            r.observe(engine.getStats().totalSize, base);
        const observeEntries = (r: { observe(v: number, a?: Attributes): void }): void =>
            r.observe(engine.getStats().entryCount, base);
        size.addCallback(observeSize);
        entries.addCallback(observeEntries);
        offs.push(() => size.removeCallback?.(observeSize));
        offs.push(() => entries.removeCallback?.(observeEntries));
    }

    return () => {
        for (const off of offs) off();
    };
}
