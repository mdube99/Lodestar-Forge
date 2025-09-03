import { db } from "../db/index.js";
import { spawnSync } from "child_process";
import {
    integrations,
    integrationPlatformEnum,
} from "../db/schema/integrations.js";
import { eq } from "drizzle-orm";

export const allIntegrations = async (req, res) => {
    const rows = await db
        .select({
            id: integrations.id,
            name: integrations.name,
            platform: integrations.platform,
        })
        .from(integrations);

    // Add useIamRole derived field based on keyId marker
    const rowsWithIamRole = rows.map((row) => ({
        ...row,
        useIamRole: row.platform === "aws" && row.keyId === "IAM_ROLE",
    }));

    return res.status(200).json(rowsWithIamRole);
};

export const createIntegration = async (req, res) => {
    try {
        const { name, platform, keyId, secretKey, useIamRole } = req.body;

        if (!name)
            return res.status(400).json({ error: "'name' is required." });
        if (!platform)
            return res.status(400).json({ error: "'platform' is required." });
        if (!integrationPlatformEnum.enumValues.includes(platform))
            return res.status(400).json({ error: "Platform not supported." });

        // Validate AWS credentials based on IAM role usage
        if (platform === "aws") {
            if (!useIamRole && !keyId)
                return res.status(400).json({
                    error: "'keyId' is required when not using IAM role.",
                });
            if (!useIamRole && !secretKey)
                return res.status(400).json({
                    error: "'secretKey' is required when not using IAM role.",
                });
        } else {
            // For non-AWS platforms, secret key is still required
            if (!secretKey)
                return res
                    .status(400)
                    .json({ error: "'secretKey' is required." });
        }

        // Use marker approach: keyId = "IAM_ROLE" for IAM role integrations
        const finalKeyId =
            useIamRole && platform === "aws" ? "IAM_ROLE" : keyId;
        const finalSecretKey =
            useIamRole && platform === "aws" ? "unused" : secretKey;

        const result = await db
            .insert(integrations)
            .values({
                name,
                platform,
                keyId: finalKeyId,
                secretKey: finalSecretKey,
            })
            .returning();

        if (result) {
            return res.status(200).json({
                id: result[0].id,
                platform: result[0].platform,
                name: result[0].name,
                useIamRole: finalKeyId === "IAM_ROLE",
            });
        } else {
            return res.status(500).json({ error: "An unknown error occured." });
        }
    } catch (e) {
        console.log(e);
        return res.status(500).json({ error: "An unknown error occured." });
    }
};

export const deleteIntegration = async (req, res) => {
    try {
        const id = req.params.integrationId;
        await db.delete(integrations).where(eq(integrations.id, id));

        return res.sendStatus(200);
    } catch (e) {
        console.log(e);
        return res.status(500).json({ error: "An unknown error occured." });
    }
};

export const checkIntegration = (req, res) => {
    try {
        const { platform, keyId, secretKey, useIamRole } = req.body;

        // Validate platform is valid
        if (!platform)
            return res.status(400).json({ error: "'platform' is required." });
        if (!integrationPlatformEnum.enumValues.includes(platform))
            return res.status(400).json({ error: "Platform not supported." });

        // Validate AWS credentials based on IAM role usage
        if (platform === "aws") {
            if (!useIamRole && !keyId)
                return res.status(400).json({
                    error: "'keyId' is required when not using IAM role.",
                });
            if (!useIamRole && !secretKey)
                return res.status(400).json({
                    error: "'secretKey' is required when not using IAM role.",
                });
        } else {
            // For non-AWS platforms, secret key is still required
            if (!secretKey)
                return res
                    .status(400)
                    .json({ error: "'secretKey' is required." });
        }

        // Set environment variables
        const envVars = {
            AWS_PAGER: "",
            PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        };

        if (platform === "aws") {
            // Only set AWS credentials if not using IAM role (keyId !== "IAM_ROLE")
            if (keyId !== "IAM_ROLE") {
                envVars.AWS_ACCESS_KEY_ID = String(keyId);
                envVars.AWS_SECRET_ACCESS_KEY = String(secretKey);
            }
        } else if (platform === "digitalocean") {
            envVars.DIGITALOCEAN_TOKEN = String(secretKey);
        }

        // Validate credential
        if (platform === "aws") {
            var result = spawnSync("aws", ["sts", "get-caller-identity"], {
                env: envVars,
            });
            if (result.status !== 0) {
                return res
                    .status(400)
                    .json({ error: "Invalid integration credentials." });
            } else {
                return res
                    .status(200)
                    .json({ message: "Integration credentials are valid." });
            }
        } else if (platform === "digitalocean") {
            envVars.HOME = "/";
            var result = spawnSync("doctl", ["auth", "init", "-t", secretKey], {
                env: envVars,
            });
            if (result.status !== 0) {
                return res
                    .status(400)
                    .json({ error: "Invalid integration credentials." });
            } else {
                return res
                    .status(200)
                    .json({ message: "Integration credentials are valid." });
            }
        } else if (platform === "tailscale") {
            fetch("https://api.tailscale.com/api/v2/tailnet/-/devices", {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${secretKey}`,
                },
            })
                .then((response) => {
                    if (!response.ok) {
                        return res.status(400).json({
                            error: "Invalid integration credentials.",
                        });
                    }
                    return res.status(200).json({
                        message: "Integration credentials are valid.",
                    });
                })
                .catch((error) => {
                    console.error(error);
                    return res
                        .status(500)
                        .json({ error: "An unknown error occured." });
                });
        }
    } catch (e) {
        console.log(e);
        return res.status(500).json({ error: "An unknown error occured." });
    }
};
