import { pgTable, text, pgEnum, timestamp, json } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { infrastructure } from "./infrastructure.js";
import { deployments } from "./deployments.js";
import crypto from "crypto";

export const infrastructureLogTypeEnum = pgEnum("infrastructure_log_type", [
    "mythic",
    "caddy",
]);

export const infrastructureLogs = pgTable("infrastructureLogs", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => crypto.randomUUID()),
    projectId: text("projectId").references(() => projects.id, {
        onDelete: "cascade",
    }),
    infrastructureId: text("infrastructureId").references(() => infrastructure.id, {
        onDelete: "cascade",
    }),
    deploymentId: text("deploymentId").references(() => deployments.id, {
        onDelete: "cascade",
    }),
    type: infrastructureLogTypeEnum("type").notNull(),
    timestamp: timestamp({ mode: "date", withTimezone: true }),
    level: text("level"),
    message: text("message"),
    rawData: json("rawData"),
    collectedAt: timestamp({ mode: "date", withTimezone: true }).defaultNow(),
});