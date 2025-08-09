import { db } from "../db/index.js";
import { and, eq, inArray, ne } from "drizzle-orm";
import { execSync, spawn } from "child_process";
import { parseKey } from "sshpk";
import fs from "fs";
import path from "path";
import { readFile } from "fs/promises";
import { quickCreateLog } from "./logs.js";
import yaml from "js-yaml";

// Import terraform templates
import { awsMain } from "../templates/system/aws/main.tf.js";
import { awsNetwork } from "../templates/system/aws/network.tf.js";
import { awsKey } from "../templates/system/aws/key.tf.js";
import { doMain } from "../templates/system/digitalocean/main.tf.js";
import { doNetwork } from "../templates/system/digitalocean/network.tf.js";
import { doKey } from "../templates/system/digitalocean/key.tf.js";

// import database schemas
import { integrations } from "../db/schema/integrations.js";
import { deployments } from "../db/schema/deployments.js";
import { domains } from "../db/schema/domains.js";
import { sshKeys } from "../db/schema/sshKeys.js";
import { infrastructure } from "../db/schema/infrastructure.js";
import { resources } from "../db/schema/resources.js";
import { templates } from "../db/schema/templates.js";
import { files } from "../db/schema/files.js";
import { settings } from "../db/schema/settings.js";

import { tailscaleUserData } from "../templates/system/general/tailscale_user_data.sh.js";

// Constants
const DEFAULT_PATH =
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEPLOYMENTS_DIR = "/app/deployments";

// Function to add to deployment log
const addToDeploymentLog = async (deploymentId, data) => {
    const [logData] = await db
        .select({ log: deployments.log })
        .from(deployments)
        .where(eq(deployments.id, deploymentId));

    const log =
        !logData?.log || logData.log === "null" ? data : logData.log + data;

    await db
        .update(deployments)
        .set({ log })
        .where(eq(deployments.id, deploymentId));
};

// Function to handle running commands
const runCommand = (deploymentId, projectId, command, args, env, cwd) => {
    return new Promise((resolve, reject) => {
        const process = spawn(command, args, { cwd, env });
        let fullLog = "";

        const handleData = async (data) => {
            await addToDeploymentLog(deploymentId, data);
            fullLog += data;
        };

        process.stdout.on("data", handleData);
        process.stderr.on("data", handleData);

        process.on("close", (code) => {
            const source = command.includes("terraform")
                ? "terraform"
                : command.includes("tailscale")
                  ? "tailscale"
                  : command.includes("ansible")
                    ? "ansible"
                    : "nucleus";

            quickCreateLog({
                message: fullLog,
                projectId,
                source,
                status: code === 0 ? "info" : "error",
                resource: deploymentId,
            });

            code === 0 ? resolve(true) : reject(false);
        });
    });
};

// Function to append Terraform resource names with a unique identifier
const updateTerraformResourceNames = (terraform, id) => {
    return terraform.replace(
        /resource\s+"([^"]+)"\s+"([^"]+)"/g,
        (_, resourceType, resourceName) => {
            const newResourceName = `${resourceName}_${id}`;
            return `resource "${resourceType}" "${newResourceName}"`;
        },
    );
};

// Function to inject SSH key into Terraform resource
const injectSshKey = (resourceType, resource, region = "") => {
    const lines = resource.split("\n");

    if (resourceType === "aws_instance") {
        lines.splice(
            lines.length - 1,
            0,
            "\n  key_name = aws_key_pair.key_pair.key_name\n",
        );
    } else if (resourceType === "digitalocean_droplet") {
        lines.splice(
            lines.length - 1,
            0,
            "\n  ssh_keys = [digitalocean_ssh_key.key_pair.id]\n",
            `\n  region = "${region}"\n`,
        );
    }
    return lines.join("\n");
};

// Function to inject user data script into Terraform resource
const injectUserDataScript = (resource, userDataScript) => {
    const userDataField = `  user_data = <<-EOF${userDataScript}\n\tEOF\n`;
    const lines = resource.split("\n");
    lines.splice(lines.length - 1, 0, userDataField);
    return lines.join("\n");
};

// Function to inject custom variables into Terraform resource
const injectTerraformVariables = (resource, variables) => {
    return variables.reduce((acc, variable) => {
        return acc.replaceAll(`$$${variable.name}$$`, variable.value);
    }, resource);
};

// Function to parse resources pulled from Terraform file
const parseTerraformResource = (terraform) => {
    const regex = /resource\s+"([^"]+)"\s+"([^"]+)"/;
    const match = terraform.match(regex);
    return match ? { type: match[1], name: match[2] } : null;
};

// Function to pull resources from Terraform file
const extractTerraformResources = (terraform) => {
    const resources = [];
    const resourceStartRegex = /resource\s+"[\w-]+"\s+"[\w-]+"\s+\{/g;
    let match;

    while ((match = resourceStartRegex.exec(terraform)) !== null) {
        const startIndex = match.index;
        const openBraceIndex = startIndex + match[0].length - 1;

        // Find the matching closing brace
        let braceCount = 1;
        let currentIndex = openBraceIndex + 1;

        while (currentIndex < terraform.length && braceCount > 0) {
            const char = terraform[currentIndex];
            if (char === "{") {
                braceCount++;
            } else if (char === "}") {
                braceCount--;
            }
            currentIndex++;
        }

        if (braceCount === 0) {
            const resourceContent = terraform.substring(
                startIndex,
                currentIndex,
            );
            resources.push(resourceContent);
        }
    }

    return resources;
};

// Handle configuration variables
const handleConfigurationVariables = async (template, variables, filesDir) => {
    for (const variable of variables) {
        if (variable.type === "file" && filesDir) {
            const [fileData] = await db
                .select()
                .from(files)
                .where(eq(files.id, variable.value));

            let fileContent = fileData.value;

            if (variable?.variables?.length > 0) {
                fileContent = await handleConfigurationVariables(
                    fileData.value,
                    variable.variables,
                );
            }

            const filePath = path.join(
                filesDir,
                `${fileData.id}.${fileData.extension}`,
            );

            fs.writeFileSync(filePath, fileContent, "utf-8");

            template = template.replaceAll(`$$${variable.name}$$`, filePath);
        } else {
            template = template.replaceAll(
                `$$${variable.name}$$`,
                variable.value,
            );
        }
    }

    return template;
};

// Function to add a host to a playbook
const addHostToPlaybook = (hostname, playbookYaml) => {
    const playbook = yaml.load(playbookYaml);
    playbook[0].hosts = hostname;
    return yaml.dump(playbook);
};

export const allDeployments = async (req, res) => {
    const { projectId } = req.query;

    const integrationRows = await db
        .select({ id: integrations.id, platform: integrations.platform })
        .from(integrations);

    const rows = await db
        .select()
        .from(deployments)
        .where(projectId ? eq(deployments.projectId, projectId) : undefined);

    const rowsWithPlatform = rows.map((row) => {
        const integration = integrationRows.find(
            (i) => i.id === row.platformId,
        );
        return {
            ...row,
            platform: integration?.platform,
        };
    });

    return res.status(200).json(rowsWithPlatform);
};

export const createDeployment = async (req, res) => {
    try {
        const {
            name,
            description,
            sshKeyId,
            platformId,
            projectId,
            tailscaleId,
            region,
        } = req.body;

        // Validate required fields
        const requiredFields = {
            name: "'name' is required.",
            sshKeyId: "'sshKeyId' is required.",
            platformId: "'platformId' is required.",
            tailscaleId: "'tailscaleId' is required.",
            projectId: "'projectId' is required.",
            region: "'region' is required.",
        };

        for (const [field, message] of Object.entries(requiredFields)) {
            if (!req.body[field]) {
                return res.status(400).json({ error: message });
            }
        }

        const [result] = await db
            .insert(deployments)
            .values({
                name,
                description,
                sshKeyId,
                platformId,
                projectId,
                tailscaleId,
                region,
            })
            .returning();

        if (result) {
            quickCreateLog({
                message: `User ${res.locals.user.id} (${res.locals.user.name}) created the deployment ${result.id} (${result.name}).`,
                projectId,
                source: "nucleus",
                status: "info",
                resource: result.id,
            });
            return res.status(200).json(result);
        }

        throw new Error("Failed to create deployment");
    } catch (e) {
        quickCreateLog({
            message: e.message,
            projectId,
            source: "nucleus",
            status: "error",
            resource: projectId,
        });
        return res.status(500).json({
            error: "An unknown error occurred, please check the activity log for more details.",
        });
    }
};

export const destroyDeployment = async (req, res) => {
    const { deploymentId } = req.params;
    if (!deploymentId) {
        return res
            .status(400)
            .json({ error: "error 'deploymentId' is required" });
    }

    const [deployment] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, deploymentId));

    if (
        deployment.status === "destroying" ||
        deployment.status === "destroyed"
    ) {
        return res.status(400).json({
            error: "Deployment is already being destroyed or destroyed",
        });
    }

    try {
        const [deploymentData] = await db
            .update(deployments)
            .set({ status: "destroying" })
            .where(eq(deployments.id, deploymentId))
            .returning();

        if (!deploymentData) {
            return res.status(404).json({ error: "Deployment not found" });
        }

        res.sendStatus(200);

        const [platform] = await db
            .select()
            .from(integrations)
            .where(eq(integrations.id, deploymentData.platformId));

        const envVars = {
            TF_CLI_ARGS: "-no-color",
            PATH: DEFAULT_PATH,
        };

        if (platform.platform === "aws") {
            // Only set AWS credentials if not using IAM role (keyId !== "IAM_ROLE")
            if (platform.keyId !== "IAM_ROLE") {
                envVars.AWS_ACCESS_KEY_ID = String(platform.keyId);
                envVars.AWS_SECRET_ACCESS_KEY = String(platform.secretKey);
            }
        } else if (platform.platform === "digitalocean") {
            envVars.DIGITALOCEAN_TOKEN = String(platform.secretKey);
        }

        const deploymentDir = path.join(DEPLOYMENTS_DIR, deploymentData.id);
        const terraformDir = path.join(deploymentDir, "terraform");

        if (
            fs.existsSync(terraformDir) &&
            fs.existsSync(path.join(terraformDir, "terraform.tfstate"))
        ) {
            try {
                await runCommand(
                    deploymentId,
                    deploymentData.projectId,
                    "terraform",
                    ["apply", "-destroy", "-auto-approve"],
                    envVars,
                    terraformDir,
                );

                // Remove ansible directories
                if (
                    fs.existsSync(
                        path.join(DEPLOYMENTS_DIR, deploymentId, "ansible"),
                    )
                ) {
                    fs.rmSync(
                        path.join(DEPLOYMENTS_DIR, deploymentId, "ansible"),
                        {
                            recursive: true,
                        },
                    );
                }

                const infrastructureRows = await db
                    .select({ id: infrastructure.id })
                    .from(infrastructure)
                    .where(eq(infrastructure.deploymentId, deploymentId));

                const allResourceRows = await db
                    .select({
                        id: resources.id,
                        infrastructureId: resources.infrastructureId,
                    })
                    .from(resources);

                infrastructureRows.map(async (infrastructureRow) => {
                    const TERRAFORM_DIR = path.join(
                        DEPLOYMENTS_DIR,
                        deploymentId,
                        "terraform",
                    );
                    if (
                        fs.existsSync(
                            path.join(
                                TERRAFORM_DIR,
                                `${infrastructureRow.id}.tf`,
                            ),
                        )
                    ) {
                        fs.rmSync(
                            path.join(
                                TERRAFORM_DIR,
                                `${infrastructureRow.id}.tf`,
                            ),
                        );
                    }

                    await db
                        .update(infrastructure)
                        .set({
                            status: "destroyed",
                            configurations: [],
                            deployedConfigurations: [],
                        })
                        .where(
                            and(
                                eq(infrastructure.id, infrastructureRow.id),
                                ne(infrastructure.status, "default"),
                            ),
                        );

                    const selectResources = allResourceRows.filter(
                        (resource) =>
                            resource.infrastructureId === infrastructureRow.id,
                    );

                    await Promise.all(
                        selectResources.map(async (resource) => {
                            await db
                                .update(resources)
                                .set({
                                    providerId: "",
                                    publicIp: "",
                                    privateIp: "",
                                    tailscaleIp: "",
                                })
                                .where(eq(resources.id, resource.id));
                        }),
                    );
                });
            } catch (e) {
                console.error(e);
                await db
                    .update(deployments)
                    .set({ status: "failed" })
                    .where(eq(deployments.id, deploymentId));
            }
        }

        const [destroyed] = await db
            .update(deployments)
            .set({ status: "destroyed" })
            .where(eq(deployments.id, deploymentId))
            .returning();

        quickCreateLog({
            message: `User ${res.locals.user.id} (${res.locals.user.name}) destroyed the deployment ${destroyed.id} (${destroyed.name}).`,
            projectId: destroyed.projectId,
            source: "nucleus",
            status: "info",
            resource: destroyed.id,
        });
    } catch (e) {
        const [updated] = await db
            .update(deployments)
            .set({ status: "failed" })
            .where(eq(deployments.id, deploymentId))
            .returning();

        quickCreateLog({
            message: e.message,
            projectId: updated.projectId,
            source: "nucleus",
            status: "error",
            resource: updated.id,
        });

        console.error(e);
    }
};

export const deleteDeployment = async (req, res) => {
    const { deploymentId } = req.params;
    if (!deploymentId) {
        return res
            .status(400)
            .json({ error: "error 'deploymentId' is required" });
    }

    const [deployment] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, deploymentId))
        .limit(1);

    if (!deployment) {
        return res.status(404).json({ error: "deployment not found" });
    }

    if (deployment.status !== "destroyed") {
        return res
            .status(400)
            .json({ error: "deployment must be destroyed first." });
    }

    res.sendStatus(200);

    try {
        if (fs.existsSync(path.join(DEPLOYMENTS_DIR, deploymentId))) {
            fs.rmSync(path.join(DEPLOYMENTS_DIR, deploymentId), {
                recursive: true,
            });
        }

        const [deleted] = await db
            .delete(deployments)
            .where(eq(deployments.id, deploymentId))
            .returning();

        quickCreateLog({
            message: `User ${res.locals.user.id} (${res.locals.user.name}) deleted the deployment ${deleted.id} (${deleted.name}).`,
            projectId: deleted.projectId,
            source: "nucleus",
            status: "info",
            resource: deleted.id,
        });
    } catch (e) {
        const [updated] = await db
            .update(deployments)
            .set({ status: "failed" })
            .where(eq(deployments.id, deploymentId))
            .returning();

        quickCreateLog({
            message: e.message,
            projectId: updated.projectId,
            source: "nucleus",
            status: "error",
            resource: updated.id,
        });

        console.error(e);
    }
};

export const prepareDeployment = async (req, res) => {
    const { deploymentId } = req.params;

    if (!deploymentId) {
        return res
            .status(400)
            .json({ error: "error 'deploymentId' is required" });
    }

    const [deploymentData] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, deploymentId));

    if (!deploymentData) {
        return res.status(404).json({ error: "Deployment not found" });
    }

    const [keyData] = await db
        .select()
        .from(sshKeys)
        .where(eq(sshKeys.id, deploymentData.sshKeyId));

    if (!keyData) {
        return res.status(404).json({ error: "SSH key not found" });
    }

    await db
        .update(deployments)
        .set({ status: "preparing" })
        .where(eq(deployments.id, deploymentId));

    res.sendStatus(200);

    const [platform] = await db
        .select()
        .from(integrations)
        .where(eq(integrations.id, deploymentData.platformId));

    const deploymentDir = path.join(DEPLOYMENTS_DIR, deploymentId);
    const terraformDir = path.join(deploymentDir, "terraform");
    const ansibleDir = path.join(deploymentDir, "ansible");
    const filesDir = path.join(deploymentDir, "files");

    // Create folder structure
    [deploymentDir, terraformDir, ansibleDir, filesDir].forEach((dir) => {
        fs.mkdirSync(dir, { recursive: true });
    });

    if (platform.platform === "aws") {
        fs.writeFileSync(
            path.join(terraformDir, "main.tf"),
            awsMain({ region: deploymentData.region }),
            "utf8",
        );

        fs.writeFileSync(
            path.join(terraformDir, "network.tf"),
            awsNetwork({ deploymentId: deploymentData.id }),
            "utf8",
        );

        const pemKey = parseKey(keyData.public, "pem");
        const sshRsa = pemKey.toString("ssh");

        fs.writeFileSync(
            path.join(terraformDir, "key.tf"),
            awsKey({
                deploymentId,
                publicKey: sshRsa,
                keyName: keyData.name,
            }),
            "utf8",
        );
    } else if (platform.platform === "digitalocean") {
        fs.writeFileSync(path.join(terraformDir, "main.tf"), doMain(), "utf8");

        fs.writeFileSync(
            path.join(terraformDir, "network.tf"),
            doNetwork({
                deploymentId: deploymentData.id,
                region: deploymentData.region,
            }),
            "utf8",
        );

        const pemKey = parseKey(keyData.public, "pem");
        const sshRsa = pemKey.toString("ssh");

        fs.writeFileSync(
            path.join(terraformDir, "key.tf"),
            doKey({
                deploymentId: deploymentData.id,
                publicKey: sshRsa,
                keyName: keyData.name,
            }),
            "utf8",
        );
    }

    fs.writeFileSync(
        path.join(deploymentDir, "private-key.pem"),
        keyData.private,
        { mode: 0o600 },
    );

    const envVars = {
        TF_CLI_ARGS: "-no-color",
        PATH: DEFAULT_PATH,
    };

    if (platform.platform === "aws") {
        // Only set AWS credentials if not using IAM role (keyId !== "IAM_ROLE")
        if (platform.keyId !== "IAM_ROLE") {
            envVars.AWS_ACCESS_KEY_ID = String(platform.keyId);
            envVars.AWS_SECRET_ACCESS_KEY = String(platform.secretKey);
        }
    } else if (platform.platform === "digitalocean") {
        envVars.DIGITALOCEAN_TOKEN = String(platform.secretKey);
    }

    try {
        await runCommand(
            deploymentId,
            deploymentData.projectId,
            "terraform",
            ["init"],
            envVars,
            terraformDir,
        );

        await runCommand(
            deploymentId,
            deploymentData.projectId,
            "terraform",
            ["apply", "-auto-approve"],
            envVars,
            terraformDir,
        );

        await db.update(deployments).set({ status: "ready-to-deploy" });

        const [defaultInfrastructure] = await db
            .select({ id: infrastructure.id })
            .from(infrastructure)
            .where(
                and(
                    eq(infrastructure.deploymentId, deploymentId),
                    eq(infrastructure.status, "default"),
                ),
            )
            .limit(1);

        let infrastructureId = String(crypto.randomUUID());

        if (defaultInfrastructure) {
            infrastructureId = defaultInfrastructure.id;
            await db
                .delete(resources)
                .where(eq(resources.infrastructureId, infrastructureId));
        } else {
            await db.insert(infrastructure).values({
                id: infrastructureId,
                deploymentId,
                name: "Forge - Default Infrastructure",
                description:
                    "The default deployment network and resources created by Lodestar Forge.",
                status: "default",
            });
        }

        const state = JSON.parse(
            await readFile(
                path.join(terraformDir, "terraform.tfstate"),
                "utf8",
            ),
        );

        const newResources = state.resources.map((resource) => ({
            infrastructureId,
            resourceName: resource.name,
            resourceType: resource.type,
            providerId: resource.instances[0].attributes.id,
            privateIp:
                resource.instances[0].attributes.private_ip ||
                resource.instances[0].attributes.cidr_block ||
                resource.instances[0].attributes.ip_range ||
                null,
            publicIp: resource.instances[0].attributes.public_ip || null,
        }));

        if (newResources.length) {
            await db.insert(resources).values(newResources);
        }
    } catch {
        await db
            .update(deployments)
            .set({ status: "failed" })
            .where(eq(deployments.id, deploymentId));
    }
};

export const deployDeployment = async (req, res) => {
    const { deploymentId } = req.params;

    // No deployment ID provided
    if (!deploymentId) {
        return res
            .status(400)
            .json({ error: "error 'deploymentId' is required" });
    }

    // Get deployment data using transactions
    const deploymentData = await db.transaction(async (tx) => {
        const [original] = await db
            .select()
            .from(deployments)
            .where(eq(deployments.id, deploymentId));

        const [updated] = await db
            .update(deployments)
            .set({ status: "deploying" })
            .where(eq(deployments.id, deploymentId))
            .returning();

        return { original, updated };
    });

    // No deployment data found
    if (!deploymentData.original) {
        return res.status(404).json({ error: "Deployment not found" });
    }

    // Do not allow - deployment already deploying
    if (deploymentData.original.status === "deploying") {
        return res
            .status(400)
            .json({ error: "Deployment is already deploying" });
    }

    // Change deployment status to building
    const infrastructureToDeploy = await db.transaction(async (tx) => {
        const original = await db
            .select()
            .from(infrastructure)
            .where(
                and(
                    inArray(infrastructure.status, [
                        "pending",
                        "failed",
                        "destroyed",
                    ]),
                    eq(infrastructure.deploymentId, deploymentId),
                ),
            );

        const updated = await db
            .update(infrastructure)
            .set({ status: "building" })
            .where(
                and(
                    inArray(infrastructure.status, [
                        "pending",
                        "failed",
                        "destroyed",
                    ]),
                    eq(infrastructure.deploymentId, deploymentId),
                ),
            )
            .returning();

        return { original, updated };
    });

    res.sendStatus(200);

    // Define directories
    const deploymentDir = path.join(DEPLOYMENTS_DIR, deploymentId);
    const terraformDir = path.join(deploymentDir, "terraform");

    // Get the settings for userdata and tailscale tag
    const settingsData = await db.select().from(settings);

    const tagSetting = settingsData.find(
        (setting) => setting.name === "tailscaleTag",
    );
    const userDataSetting = settingsData.find(
        (setting) => setting.name === "userData",
    );

    // Get tailscale key
    const [tailscaleKey] = await db
        .select()
        .from(integrations)
        .where(eq(integrations.id, deploymentData.original.tailscaleId));

    // Get all infrastructure templates
    const templatesData = await db
        .select()
        .from(templates)
        .where(eq(templates.type, "infrastructure"));

    // For each peice of infrastructure to deploy
    infrastructureToDeploy.original.forEach(async (infrastructureRow) => {
        let isDestroyed = infrastructureRow.status === "destroyed";
        const template = templatesData.find(
            (template) => template.id === infrastructureRow.template.id,
        );

        if (isDestroyed) {
            await db
                .delete(resources)
                .where(eq(resources.infrastructureId, infrastructureRow.id));
        }

        // Extract terraform resources from template
        const resourceArray = extractTerraformResources(template.value);
        let finalContent = "";
        const updatedResourceMappings = [];

        await Promise.all(
            resourceArray.map(async (resource) => {
                // For each resource, generate a UUID
                const resourceUUID = crypto.randomUUID();
                const oldParsedResource = parseTerraformResource(resource);

                // Inject custom template variables
                let updatedResource = injectTerraformVariables(
                    resource,
                    infrastructureRow.template.variables,
                );
                updatedResource = updateTerraformResourceNames(
                    updatedResource,
                    resourceUUID,
                );

                if (
                    oldParsedResource.type === "aws_instance" ||
                    oldParsedResource.type === "digitalocean_droplet"
                ) {
                    updatedResource = injectSshKey(
                        oldParsedResource.type,
                        updatedResource,
                        deploymentData.original.region,
                    );

                    const tailscaleResult = await fetch(
                        "https://api.tailscale.com/api/v2/tailnet/-/keys?all=true",
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                Authorization: `Bearer ${tailscaleKey.secretKey}`,
                            },
                            body: JSON.stringify({
                                capabilities: {
                                    devices: {
                                        create: {
                                            reusable: false,
                                            ephemeral: true,
                                            preauthorized: true,
                                            tags: tagSetting?.value
                                                ? [`tag:${tagSetting.value}`]
                                                : [],
                                        },
                                    },
                                },
                                expirySeconds: 86400,
                            }),
                        },
                    );

                    const newKey = await tailscaleResult.json();

                    const userDataScript = tailscaleUserData({
                        authKey: newKey.key,
                        resourceId: infrastructureRow.id,
                        resourceName: infrastructureRow.name,
                        custom: userDataSetting?.value
                            ? userDataSetting.value
                            : "",
                    });

                    updatedResource = injectUserDataScript(
                        updatedResource,
                        userDataScript,
                    );
                }

                finalContent = finalContent.concat(updatedResource + "\n\n");

                const newParsedResource =
                    parseTerraformResource(updatedResource);
                updatedResourceMappings.push({
                    old: `${oldParsedResource?.type}.${oldParsedResource?.name}`,
                    new: `${newParsedResource?.type}.${newParsedResource?.name}`,
                });

                await db.insert(resources).values({
                    id: resourceUUID,
                    infrastructureId: infrastructureRow.id,
                    resourceType: newParsedResource.type,
                    resourceName: newParsedResource.name,
                    status: "pending",
                });
            }),
        );

        updatedResourceMappings.forEach((mapping) => {
            finalContent = finalContent.replace(mapping.old, mapping.new);
        });

        fs.writeFileSync(
            path.join(terraformDir, `${infrastructureRow.id}.tf`),
            finalContent,
        );
    });

    // Get the platform used for this deployment
    const [platform] = await db
        .select()
        .from(integrations)
        .where(eq(integrations.id, deploymentData.original.platformId));

    // Terraform environment variables
    const envVars = {
        TF_CLI_ARGS: "-no-color",
        PATH: DEFAULT_PATH,
    };

    // Set remaining environment variables based on the platform
    if (platform.platform === "aws") {
        // Only set AWS credentials if not using IAM role (keyId !== "IAM_ROLE")
        if (platform.keyId !== "IAM_ROLE") {
            envVars.AWS_ACCESS_KEY_ID = String(platform.keyId);
            envVars.AWS_SECRET_ACCESS_KEY = String(platform.secretKey);
        }
    } else if (platform.platform === "digitalocean") {
        envVars.DIGITALOCEAN_TOKEN = String(platform.secretKey);
    }

    try {
        // Format terraform files to prevent issues
        await runCommand(
            deploymentId,
            deploymentData.original.projectId,
            "terraform",
            ["fmt"],
            { TF_CLI_ARGS: "-no-color" },
            terraformDir,
        );

        // Apply changes to infrastructure
        await runCommand(
            deploymentId,
            deploymentData.original.projectId,
            "terraform",
            ["apply", "-auto-approve"],
            envVars,
            terraformDir,
        );

        // Get the terraform state file
        const state = JSON.parse(
            await readFile(
                path.join(terraformDir, "terraform.tfstate"),
                "utf8",
            ),
        );

        const stateResources = state.resources;

        // For each piece of infrastructure
        for (const infrastructureRow of infrastructureToDeploy.original) {
            try {
                // Get resources for the current infrastructure
                const resourceRows = await db
                    .select()
                    .from(resources)
                    .where(
                        eq(resources.infrastructureId, infrastructureRow.id),
                    );

                let username = "";

                for (const resourceRow of resourceRows) {
                    const stateResource = stateResources.find(
                        (r) => r.name === resourceRow.resourceName,
                    );

                    // Attempt to retrieve the username so Ansible can use it.

                    const amiId = stateResource.instances[0].attributes?.ami;
                    const imageName =
                        stateResource.instances[0].attributes?.image;

                    if (amiId) {
                        // If the instance has an AMI, describe the image
                        const awsEnv = {
                            AWS_DEFAULT_REGION: deploymentData.original.region
                                ? deploymentData.original.region
                                : stateResource.instances[0].attributes.arn.split(":")[3],
                        };
                        
                        // Only add credentials if not using IAM role (keyId !== "IAM_ROLE")
                        if (platform.keyId !== "IAM_ROLE") {
                            awsEnv.AWS_ACCESS_KEY_ID = platform.keyId;
                            awsEnv.AWS_SECRET_ACCESS_KEY = platform.secretKey;
                        }
                        
                        const result = execSync(
                            `aws ec2 describe-images --image-ids ${amiId} --query "Images[0].{Name:Name,Description:Description}" --output json`,
                            {
                                env: awsEnv,
                            },
                        );

                        const ami = JSON.parse(result.toString());
                        const amiName = ami.Name.toLowerCase();
                        const amiDescription = ami.Description.toLowerCase();

                        // Attempt to determine the username based on the AMI name or description
                        if (
                            amiName.includes("ubuntu") ||
                            amiDescription.includes("ubuntu")
                        ) {
                            username = "ubuntu";
                        } else if (amiName.includes("centos")) {
                            username = "centos";
                        } else if (amiName.includes("debian")) {
                            username = "admin";
                        } else if (amiName.includes("fedora")) {
                            username = "fedora";
                        } else {
                            username = "ec2-user";
                        }
                    } else if (imageName) {
                        // DigitalOcean uses root user
                        username = "root";
                    }

                    const domain =
                        stateResource.instances[0].attributes.domain_name;
                    if (domain) {
                        await db.insert(domains).values({
                            domain,
                            projectId: deploymentData.original.projectId,
                        });
                    }

                    // Update resources with networking information
                    await db
                        .update(resources)
                        .set({
                            providerId:
                                stateResource.instances[0].attributes.id,
                            domain,
                            privateIp:
                                stateResource.instances[0].attributes
                                    .private_ip ||
                                stateResource.instances[0].attributes
                                    .ipv4_address_private ||
                                stateResource.instances[0].attributes
                                    .cidr_block ||
                                null,
                            publicIp:
                                stateResource.instances[0].attributes
                                    .public_ip ||
                                stateResource.instances[0].attributes
                                    .ipv4_address ||
                                null,
                        })
                        .where(eq(resources.id, resourceRow.id));
                }

                // Change infrastructure status and username
                await db
                    .update(infrastructure)
                    .set({
                        status:
                            infrastructureRow.status === "default"
                                ? "default"
                                : "running",
                        username,
                    })
                    .where(eq(infrastructure.id, infrastructureRow.id));
            } catch (e) {
                // If something fails, change the infrastructure status to failed
                console.error(e);
                await db
                    .update(infrastructure)
                    .set({ status: "failed" })
                    .where(eq(infrastructure.deploymentId, deploymentId));
            }
        }

        // Finally change the status of the deployment
        await db
            .update(deployments)
            .set({ status: "ready-to-configure" })
            .where(eq(deployments.id, deploymentId));
    } catch (e) {
        // If something fails, change the deployment status to failed
        console.error(e);
        await db
            .update(deployments)
            .set({ status: "failed" })
            .where(eq(deployments.id, deploymentId));
    }
};

export const configureDeployment = async (req, res) => {
    const { deploymentId } = req.params;

    if (!deploymentId) {
        return res
            .status(400)
            .json({ error: "error 'deploymentId' is required" });
    }

    const [deploymentData] = await db
        .update(deployments)
        .set({ status: "configuring" })
        .where(eq(deployments.id, deploymentId))
        .returning();

    if (!deploymentData) {
        return res.status(404).json({ error: "deployment not found" });
    }

    res.sendStatus(200);

    const [tailscaleKey] = await db
        .select()
        .from(integrations)
        .where(eq(integrations.id, deploymentData.tailscaleId));

    const infrastructureData = await db
        .select()
        .from(infrastructure)
        .where(eq(infrastructure.deploymentId, deploymentId));

    const templatesData = await db
        .select()
        .from(templates)
        .where(eq(templates.type, "configuration"));

    const deploymentDir = path.join(DEPLOYMENTS_DIR, deploymentId);
    const ansibleDir = path.join(deploymentDir, "ansible");
    const filesDir = path.join(deploymentDir, "files");

    const infrastructureWithConfigurations = infrastructureData.filter(
        (i) => i.configurations?.length > 0,
    );

    let inventoryFileContent = "forge:\n  hosts:\n";
    let mainPlaybookFileContent = "---";

    for (const infrastructure of infrastructureWithConfigurations) {
        const resourceData = await db
            .select()
            .from(resources)
            .where(eq(resources.infrastructureId, infrastructure.id));

        const tailscaleIp = resourceData.find(
            (resource) => resource.tailscaleIp !== null,
        )?.tailscaleIp;

        inventoryFileContent += `    ${infrastructure.id.split("-").join("_")}:\n      ansible_host: ${tailscaleIp}\n      ansible_user: ${infrastructure.username}\n`;

        for (const configuration of infrastructure.configurations || []) {
            const configurationTemplate = templatesData.find(
                (t) => t.id === configuration.template,
            );

            if (!configurationTemplate) continue;

            mainPlaybookFileContent += `\n- name: ${configuration.id}\n  import_playbook: ${configuration.id}.yml\n\n`;

            let ansibleData = await handleConfigurationVariables(
                configurationTemplate.value,
                configuration.variables,
                filesDir,
            );

            ansibleData = addHostToPlaybook(
                infrastructure.id.split("-").join("_"),
                ansibleData,
            );

            fs.writeFileSync(
                path.join(ansibleDir, `${configuration.id}.yml`),
                ansibleData,
                "utf8",
            );
        }
    }

    fs.writeFileSync(
        path.join(ansibleDir, "inventory.yml"),
        inventoryFileContent,
        "utf8",
    );

    fs.writeFileSync(
        path.join(ansibleDir, "main.yml"),
        mainPlaybookFileContent,
        "utf8",
    );

    const [tagSetting] = await db
        .select()
        .from(settings)
        .where(eq(settings.name, "tailscaleTag"));

    const tailscaleResult = await fetch(
        "https://api.tailscale.com/api/v2/tailnet/-/keys?all=true",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${tailscaleKey.secretKey}`,
            },
            body: JSON.stringify({
                capabilities: {
                    devices: {
                        create: {
                            reusable: false,
                            ephemeral: true,
                            preauthorized: true,
                            tags: tagSetting ? [`tag:${tagSetting.value}`] : [],
                        },
                    },
                    expirySeconds: 86400,
                },
            }),
        },
    );

    const newKey = await tailscaleResult.json();

    try {
        // Disconnect from tailscale before reconnecting (sometimes it remains connected)
        await runCommand(deploymentId, deploymentData.projectId, "tailscale", [
            "logout",
        ]);

        await runCommand(deploymentId, deploymentData.projectId, "tailscale", [
            "up",
            `--auth-key=${newKey.key}`,
            "--accept-dns=false",
            `--hostname=${
                String(
                    "lodestar-forge-nucleus" + "-" + deploymentId.split("-")[0],
                )
                    .toLowerCase() // Lowercase everything
                    .replace(/[^a-z0-9-]+/g, "-") // Replace invalid characters with hyphen
                    .replace(/^-+|-+$/g, "") // Trim leading/trailing hyphens
                    .replace(/-+/g, "-") // Collapse multiple hyphens
                    .slice(0, 63) // Trim to 63 characters max
            }`,
        ]);

        const [ansibleOutput] = await db
            .select()
            .from(settings)
            .where(eq(settings.name, "ansibleOutput"));

        const ansibleArgs = [
            "-i",
            "inventory.yml",
            "--private-key=../private-key.pem",
            "main.yml",
        ];

        if (ansibleOutput?.value === "verbose") {
            ansibleArgs.push("-vvv");
        }

        await runCommand(
            deploymentId,
            deploymentData.projectId,
            "ansible-playbook",
            ansibleArgs,
            {
                PATH: `${DEFAULT_PATH}:/root/.local/bin`,
                ANSIBLE_HOST_KEY_CHECKING: "False",
            },
            ansibleDir,
        );

        await db
            .update(deployments)
            .set({ status: "live" })
            .where(eq(deployments.id, deploymentId));
    } catch {
        await db
            .update(deployments)
            .set({ status: "failed" })
            .where(eq(deployments.id, deploymentId));
    } finally {
        // Disconnect from tailscale
        await runCommand(deploymentId, deploymentData.projectId, "tailscale", [
            "logout",
        ]);
    }
};
