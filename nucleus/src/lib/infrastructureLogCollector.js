import { spawn } from "child_process";
import { db } from "../db/index.js";
import { infrastructure } from "../db/schema/infrastructure.js";
import { resources } from "../db/schema/resources.js";
import { sshKeys } from "../db/schema/sshKeys.js";
import { deployments } from "../db/schema/deployments.js";
import { infrastructureLogs } from "../db/schema/infrastructureLogs.js";
import { eq, and, desc } from "drizzle-orm";
import fs from "fs";
import path from "path";
import os from "os";

const LOG_PATHS = {
    mythic: "/opt/mythic/logs/mythic.log",
    caddy: "/opt/caddy/site/c2.log",
};

export const determineLogTypes = (infrastructure) => {
    const types = [];
    const configs = infrastructure.configurations || [];
    
    if (configs.some(c => JSON.stringify(c).toLowerCase().includes('mythic'))) {
        types.push('mythic');
    }
    if (configs.some(c => JSON.stringify(c).toLowerCase().includes('caddy'))) {
        types.push('caddy');
    }
    
    return types;
};

export const scpFetch = async (tailscaleIp, privateKey, remotePath) => {
    return new Promise((resolve, reject) => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestar-logs-'));
        const keyFile = path.join(tempDir, 'key');
        const localFile = path.join(tempDir, 'log');
        
        try {
            fs.writeFileSync(keyFile, privateKey, { mode: 0o600 });
            
            const scpProcess = spawn('scp', [
                '-i', keyFile,
                '-o', 'StrictHostKeyChecking=no',
                '-o', 'UserKnownHostsFile=/dev/null',
                '-o', 'ConnectTimeout=10',
                `root@${tailscaleIp}:${remotePath}`,
                localFile
            ]);
            
            let stderr = '';
            
            scpProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            scpProcess.on('close', (code) => {
                if (code === 0 && fs.existsSync(localFile)) {
                    const content = fs.readFileSync(localFile, 'utf8');
                    fs.rmSync(tempDir, { recursive: true, force: true });
                    resolve(content);
                } else {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                    reject(new Error(`SCP failed with code ${code}: ${stderr}`));
                }
            });
            
            scpProcess.on('error', (error) => {
                fs.rmSync(tempDir, { recursive: true, force: true });
                reject(error);
            });
        } catch (error) {
            fs.rmSync(tempDir, { recursive: true, force: true });
            reject(error);
        }
    });
};

export const formatMythicMessage = (entry) => {
    const msg = entry.message;
    
    switch (entry.mythic_object) {
        case 'task_new':
            return `Task '${msg.command}' created by ${msg.operator}`;
        case 'task_completed':
            return `Task '${msg.command}' completed by ${msg.operator}`;
        case 'callback_new':
            return `New callback from ${msg.user}@${msg.host} (${msg.ip})`;
        case 'response_new':
            return `Response received for task ${msg.task?.command || 'unknown'}`;
        case 'artifact_new':
            return `Artifact created: ${msg.artifact_template} (${msg.artifact_instance})`;
        case 'file_upload':
            return `File uploaded: ${msg.filename} (${msg.md5})`;
        case 'file_download':
            return `File downloaded: ${msg.filename}`;
        case 'file_screenshot':
            return `Screenshot captured for task ${msg.command}`;
        case 'payload_new':
            return `Payload created: ${msg.payload_type} by ${msg.operator}`;
        case 'eventlog_new':
            return `Event logged: ${msg.message} (${msg.level})`;
        case 'credential_new':
            return `Credential added: ${msg.account}@${msg.realm}`;
        case 'task_comment':
            return `Task comment: ${msg.comment} by ${msg.comment_operator}`;
        default:
            return `${entry.mythic_object}: ${JSON.stringify(msg).substring(0, 100)}`;
    }
};

export const formatCaddyMessage = (entry) => {
    if (entry.msg?.includes('aborting with incomplete response')) {
        const req = entry.request;
        return `HTTP request failed: ${req?.method} ${req?.uri} from ${req?.remote_ip}`;
    }
    if (entry.request) {
        const req = entry.request;
        return `${req.method} ${req.uri} from ${req.remote_ip} - ${entry.msg}`;
    }
    return entry.msg || 'Unknown Caddy event';
};

export const parseMythicLogs = (content, lastTimestamp) => {
    return content.split('\n')
        .filter(line => line.trim())
        .map(line => {
            try {
                const entry = JSON.parse(line);
                const logTimestamp = new Date(entry.timestamp);
                
                if (lastTimestamp && logTimestamp <= lastTimestamp) {
                    return null;
                }
                
                return {
                    timestamp: logTimestamp,
                    level: entry.mythic_object,
                    message: formatMythicMessage(entry),
                    rawData: entry
                };
            } catch (e) {
                return null;
            }
        })
        .filter(Boolean);
};

export const parseCaddyLogs = (content, lastTimestamp) => {
    return content.split('\n')
        .filter(line => line.trim())
        .map(line => {
            try {
                const entry = JSON.parse(line);
                const logTimestamp = new Date(entry.ts * 1000);
                
                if (lastTimestamp && logTimestamp <= lastTimestamp) {
                    return null;
                }
                
                return {
                    timestamp: logTimestamp,
                    level: entry.level,
                    message: formatCaddyMessage(entry),
                    rawData: entry
                };
            } catch (e) {
                return null;
            }
        })
        .filter(Boolean);
};

export const getLastLogTimestamp = async (infrastructureId, type) => {
    const result = await db
        .select({ timestamp: infrastructureLogs.timestamp })
        .from(infrastructureLogs)
        .where(
            and(
                eq(infrastructureLogs.infrastructureId, infrastructureId),
                eq(infrastructureLogs.type, type)
            )
        )
        .orderBy(desc(infrastructureLogs.timestamp))
        .limit(1);
    
    return result[0]?.timestamp || null;
};

export const collectLogsForInfrastructure = async (infrastructureId) => {
    try {
        const [infraData] = await db
            .select({
                id: infrastructure.id,
                deploymentId: infrastructure.deploymentId,
                configurations: infrastructure.configurations,
            })
            .from(infrastructure)
            .where(eq(infrastructure.id, infrastructureId));
        
        if (!infraData) {
            throw new Error(`Infrastructure ${infrastructureId} not found`);
        }
        
        const [deployment] = await db
            .select({
                projectId: deployments.projectId,
                sshKeyId: deployments.sshKeyId,
            })
            .from(deployments)
            .where(eq(deployments.id, infraData.deploymentId));
        
        if (!deployment) {
            throw new Error(`Deployment for infrastructure ${infrastructureId} not found`);
        }
        
        const resourceData = await db
            .select({ tailscaleIp: resources.tailscaleIp })
            .from(resources)
            .where(eq(resources.infrastructureId, infrastructureId));
        
        const tailscaleIp = resourceData.find(r => r.tailscaleIp)?.tailscaleIp;
        if (!tailscaleIp) {
            throw new Error(`No Tailscale IP found for infrastructure ${infrastructureId}`);
        }
        
        const [sshKeyData] = await db
            .select({ private: sshKeys.private })
            .from(sshKeys)
            .where(eq(sshKeys.id, deployment.sshKeyId));

        if (!sshKeyData) {
            throw new Error(`SSH key not found for infrastructure ${infrastructureId}`);
        }

        const privateKey = sshKeyData.private;
        const logTypes = determineLogTypes(infraData);
        
        for (const logType of logTypes) {
            try {
                const remotePath = LOG_PATHS[logType];
                const lastTimestamp = await getLastLogTimestamp(infrastructureId, logType);
                
                const content = await scpFetch(tailscaleIp, privateKey, remotePath);
                
                let parsedLogs = [];
                if (logType === 'mythic') {
                    parsedLogs = parseMythicLogs(content, lastTimestamp);
                } else if (logType === 'caddy') {
                    parsedLogs = parseCaddyLogs(content, lastTimestamp);
                }
                
                if (parsedLogs.length > 0) {
                    const logEntries = parsedLogs.map(log => ({
                        projectId: deployment.projectId,
                        infrastructureId: infrastructureId,
                        deploymentId: infraData.deploymentId,
                        type: logType,
                        timestamp: log.timestamp,
                        level: log.level,
                        message: log.message,
                        rawData: log.rawData,
                    }));
                    
                    await db.insert(infrastructureLogs).values(logEntries);
                    console.log(`Collected ${parsedLogs.length} ${logType} logs for infrastructure ${infrastructureId}`);
                }
            } catch (error) {
                console.error(`Failed to collect ${logType} logs for infrastructure ${infrastructureId}:`, error.message);
            }
        }
    } catch (error) {
        console.error(`Failed to collect logs for infrastructure ${infrastructureId}:`, error.message);
    }
};

export const getActiveInfrastructure = async () => {
    return await db
        .select({
            id: infrastructure.id,
            status: infrastructure.status,
        })
        .from(infrastructure)
        .where(eq(infrastructure.status, "running"));
};

export const startInfrastructureLogCollection = () => {
    console.log("Starting infrastructure log collection scheduler (every 2 minutes)");
    
    setInterval(async () => {
        try {
            const activeInfrastructure = await getActiveInfrastructure();
            console.log(`Collecting logs for ${activeInfrastructure.length} active infrastructure instances`);
            
            for (const infra of activeInfrastructure) {
                await collectLogsForInfrastructure(infra.id);
            }
        } catch (error) {
            console.error("Error during scheduled log collection:", error);
        }
    }, 2 * 60 * 1000);
};