import { CacheEngine } from "./cache-engine";
import { AdminPanelData, CacheEventData, QueryResult } from "./types";
import { formatBytes, formatDuration, formatPercentage } from "./utils";

export class CacheAdminPanel {
    private cache: CacheEngine;
    private recentActivity: CacheEventData[] = [];
    private maxActivityLog = 100;

    constructor(cache: CacheEngine) {
        this.cache = cache;
        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        const events: Array<"set" | "get" | "delete" | "clear" | "evict" | "hit" | "miss" | "expire"> = [
            "set",
            "get",
            "delete",
            "clear",
            "evict",
            "hit",
            "miss",
            "expire",
        ];

        events.forEach((event) => {
            this.cache.on(event, (data) => {
                this.recentActivity.unshift(data);
                if (this.recentActivity.length > this.maxActivityLog) {
                    this.recentActivity.pop();
                }
            });
        });
    }

    async getData(): Promise<AdminPanelData> {
        const stats = await this.cache.getDetailedStats();
        const health = await this.getHealth();
        const entries = await this.cache.query({
            sortBy: "lastAccessed",
            sortOrder: "desc",
            limit: 50,
        });
        const topKeys = await this.getTopKeys(10);

        return {
            stats,
            entries,
            topKeys,
            recentActivity: this.recentActivity.slice(0, 50),
            health,
        };
    }

    private async getTopKeys(
        limit: number
    ): Promise<Array<{ key: string; accessCount: number; size: number }>> {
        const all = await this.cache.query({
            sortBy: "accessCount",
            sortOrder: "desc",
            limit,
        });

        return all.map((item) => ({
            key: item.key,
            accessCount: item.entry.accessCount || 0,
            size: item.entry.size,
        }));
    }

    private async getHealth(): Promise<AdminPanelData["health"]> {
        const health = await this.cache.getHealth();
        const stats = this.cache.getStats();
        const storageInfo = await this.cache.getStorageInfo();

        const warnings: string[] = [];
        const recommendations: string[] = [];

        // Check hit rate
        if (stats.hitRate < 0.5) {
            warnings.push("Low cache hit rate (< 50%)");
            recommendations.push("Consider increasing TTL or reviewing cache keys");
        }

        // Check storage
        if (storageInfo.percentage > 0.9) {
            warnings.push("Storage usage above 90%");
            recommendations.push("Consider clearing old entries or increasing maxSize");
        }

        // Check errors
        if (stats.errors > 10) {
            warnings.push(`High error count: ${stats.errors}`);
            recommendations.push("Check error logs and plugin configuration");
        }

        // Determine status
        let status: "healthy" | "warning" | "critical" = "healthy";
        if (warnings.length > 0) {
            status = warnings.some((w) => w.includes("critical")) ? "critical" : "warning";
        }

        return {
            status,
            warnings: [...health.issues, ...warnings],
            recommendations,
        };
    }

    getRecentActivity(limit?: number): CacheEventData[] {
        return this.recentActivity.slice(0, limit || 50);
    }

    async generateReport(): Promise<string> {
        const data = await this.getData();
        const { stats, health, topKeys } = data;

        let report = "=".repeat(60) + "\n";
        report += "CACHECRAFT ADMIN REPORT\n";
        report += "=".repeat(60) + "\n\n";

        // Health Status
        report += `Health Status: ${health.status.toUpperCase()}\n`;
        report += `Warnings: ${health.warnings.length}\n`;
        if (health.warnings.length > 0) {
            health.warnings.forEach((w) => (report += `  - ${w}\n`));
        }
        report += "\n";

        // Statistics
        report += "STATISTICS\n";
        report += "-".repeat(60) + "\n";
        report += `Total Size: ${formatBytes(stats.totalSize)}\n`;
        report += `Entry Count: ${stats.entryCount}\n`;
        report += `Hit Rate: ${formatPercentage(stats.hitRate)}\n`;
        report += `Miss Rate: ${formatPercentage(stats.missRate)}\n`;
        report += `Total Hits: ${stats.hits}\n`;
        report += `Total Misses: ${stats.misses}\n`;
        report += `Total Sets: ${stats.sets}\n`;
        report += `Total Deletes: ${stats.deletes}\n`;
        report += `Total Evictions: ${stats.evictions}\n`;
        report += `Errors: ${stats.errors}\n`;
        report += `Avg Access Time: ${formatDuration(stats.avgAccessTime)}\n`;
        report += `Compression Ratio: ${formatPercentage(stats.compressionRatio)}\n`;
        report += `Encrypted Entries: ${stats.encryptedCount}\n`;
        report += `Expired Entries: ${stats.expiredCount}\n`;
        report += "\n";

        // Top Keys
        report += "TOP ACCESSED KEYS\n";
        report += "-".repeat(60) + "\n";
        topKeys.slice(0, 10).forEach((item, i) => {
            report += `${i + 1}. ${item.key}\n`;
            report += `   Access Count: ${item.accessCount}\n`;
            report += `   Size: ${formatBytes(item.size)}\n`;
        });
        report += "\n";

        // Entries by Tag
        if (Object.keys(stats.entriesByTag).length > 0) {
            report += "ENTRIES BY TAG\n";
            report += "-".repeat(60) + "\n";
            Object.entries(stats.entriesByTag).forEach(([tag, count]) => {
                const size = stats.sizeByTag[tag] || 0;
                report += `${tag}: ${count} entries (${formatBytes(size)})\n`;
            });
            report += "\n";
        }

        // Recommendations
        if (health.recommendations.length > 0) {
            report += "RECOMMENDATIONS\n";
            report += "-".repeat(60) + "\n";
            health.recommendations.forEach((rec) => (report += `- ${rec}\n`));
            report += "\n";
        }

        report += "=".repeat(60) + "\n";
        report += `Generated: ${new Date().toISOString()}\n`;
        report += "=".repeat(60) + "\n";

        return report;
    }

    // Dashboard data for UI
    async getDashboardData(): Promise<{
        overview: {
            totalSize: string;
            entryCount: number;
            hitRate: string;
            status: string;
        };
        charts: {
            hitMissRatio: { hits: number; misses: number };
            sizeByTag: Record<string, number>;
            recentActivity: Array<{ timestamp: number; event: string }>;
        };
        alerts: string[];
    }> {
        const data = await this.getData();
        const { stats, health } = data;

        return {
            overview: {
                totalSize: formatBytes(stats.totalSize),
                entryCount: stats.entryCount,
                hitRate: formatPercentage(stats.hitRate),
                status: health.status,
            },
            charts: {
                hitMissRatio: {
                    hits: stats.hits,
                    misses: stats.misses,
                },
                sizeByTag: stats.sizeByTag,
                recentActivity: this.recentActivity.slice(0, 20).map((a) => ({
                    timestamp: a.timestamp,
                    event: a.event,
                })),
            },
            alerts: health.warnings,
        };
    }
}

// ==============================
// Cache Monitor (Real-time monitoring)
// ==============================

export class CacheMonitor {
    private cache: CacheEngine;
    private metrics: Array<{
        timestamp: number;
        operation: string;
        duration: number;
        success: boolean;
    }> = [];
    private maxMetrics = 1000;

    constructor(cache: CacheEngine) {
        this.cache = cache;
    }

    track(operation: string, duration: number, success: boolean): void {
        this.metrics.unshift({
            timestamp: Date.now(),
            operation,
            duration,
            success,
        });

        if (this.metrics.length > this.maxMetrics) {
            this.metrics.pop();
        }
    }

    getMetrics(
        operation?: string,
        lastMinutes?: number
    ): Array<{ timestamp: number; operation: string; duration: number; success: boolean }> {
        let filtered = this.metrics;

        if (operation) {
            filtered = filtered.filter((m) => m.operation === operation);
        }

        if (lastMinutes) {
            const cutoff = Date.now() - lastMinutes * 60 * 1000;
            filtered = filtered.filter((m) => m.timestamp > cutoff);
        }

        return filtered;
    }

    getAverageDuration(operation?: string): number {
        const metrics = operation
            ? this.metrics.filter((m) => m.operation === operation)
            : this.metrics;

        if (metrics.length === 0) return 0;

        const sum = metrics.reduce((acc, m) => acc + m.duration, 0);
        return sum / metrics.length;
    }

    getSuccessRate(operation?: string): number {
        const metrics = operation
            ? this.metrics.filter((m) => m.operation === operation)
            : this.metrics;

        if (metrics.length === 0) return 0;

        const successful = metrics.filter((m) => m.success).length;
        return successful / metrics.length;
    }

    clear(): void {
        this.metrics = [];
    }
}
