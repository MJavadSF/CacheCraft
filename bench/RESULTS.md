# Benchmarks

Run with `npm run bench` (real Chromium via Playwright; IndexedDB on a localhost origin).
Numbers vary between runs and machines by roughly ±30 %; compare libraries within one run.
CacheCraft does more per call than a bare key-value store (expiry, decoding, stats, events, access tracking).
Chromium 153.0.8010.12 · 2026-11-15 · 200 keys, ~1 KB JSON values

| Benchmark | ops/sec | mean (ms) | p99 (ms) |
|---|---:|---:|---:|
| get · CacheCraft | 5,236 | 0.241 | 0.600 |
| get · CacheCraft + memoryCache | 313,516 | 0.003 | 0.100 |
| get · idb-keyval | 7,752 | 0.147 | 0.400 |
| get · localForage | 8,198 | 0.132 | 0.300 |
| get · Dexie | 7,298 | 0.203 | 0.600 |
| set · CacheCraft | 3,187 | 0.375 | 1.800 |
| set · idb-keyval | 4,804 | 0.252 | 0.527 |
| set · localForage | 5,288 | 0.237 | 0.500 |
| set · Dexie | 3,280 | 1.021 | 1.217 |
| getMany(50) · CacheCraft | 238 | 4.572 | 12.200 |
| bulkGet(50) · Dexie | 427 | 2.449 | 5.384 |
| getOrSet (hit) · CacheCraft | 6,180 | 0.224 | 0.700 |
