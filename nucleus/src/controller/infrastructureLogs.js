import { db } from "../db/index.js";
import { infrastructureLogs } from "../db/schema/infrastructureLogs.js";
import { infrastructure } from "../db/schema/infrastructure.js";
import { deployments } from "../db/schema/deployments.js";
import { desc, eq, and } from "drizzle-orm";
import { collectLogsForInfrastructure } from "../lib/infrastructureLogCollector.js";

export const getInfrastructureLogs = async (req, res) => {
    try {
        const { projectId, infrastructureId, type, limit = 100 } = req.query;

        let query = db
            .select({
                id: infrastructureLogs.id,
                infrastructureId: infrastructureLogs.infrastructureId,
                type: infrastructureLogs.type,
                timestamp: infrastructureLogs.timestamp,
                level: infrastructureLogs.level,
                message: infrastructureLogs.message,
                rawData: infrastructureLogs.rawData,
                collectedAt: infrastructureLogs.collectedAt,
            })
            .from(infrastructureLogs);

        const conditions = [];

        if (projectId) {
            conditions.push(eq(infrastructureLogs.projectId, projectId));
        }

        if (infrastructureId) {
            conditions.push(eq(infrastructureLogs.infrastructureId, infrastructureId));
        }

        if (type) {
            conditions.push(eq(infrastructureLogs.type, type));
        }

        if (conditions.length > 0) {
            query = query.where(and(...conditions));
        }

        const rows = await query
            .orderBy(desc(infrastructureLogs.timestamp))
            .limit(parseInt(limit));

        return res.status(200).json(rows);
    } catch (error) {
        console.error("Error fetching infrastructure logs:", error);
        return res.status(500).json({ error: "Failed to fetch infrastructure logs" });
    }
};

export const collectInfrastructureLogs = async (req, res) => {
    try {
        const { infrastructureId } = req.params;

        if (!infrastructureId) {
            return res.status(400).json({ error: "'infrastructureId' is required" });
        }

        await collectLogsForInfrastructure(infrastructureId);

        return res.status(200).json({ message: "Log collection initiated" });
    } catch (error) {
        console.error("Error collecting infrastructure logs:", error);
        return res.status(500).json({ error: "Failed to collect infrastructure logs" });
    }
};

export const getInfrastructureLogStats = async (req, res) => {
    try {
        const { projectId } = req.query;

        let query = db
            .select({
                infrastructureId: infrastructureLogs.infrastructureId,
                type: infrastructureLogs.type,
                count: db.count(),
                lastCollected: db.max(infrastructureLogs.collectedAt),
            })
            .from(infrastructureLogs);

        if (projectId) {
            query = query.where(eq(infrastructureLogs.projectId, projectId));
        }

        const stats = await query
            .groupBy(infrastructureLogs.infrastructureId, infrastructureLogs.type);

        return res.status(200).json(stats);
    } catch (error) {
        console.error("Error fetching infrastructure log stats:", error);
        return res.status(500).json({ error: "Failed to fetch infrastructure log stats" });
    }
};