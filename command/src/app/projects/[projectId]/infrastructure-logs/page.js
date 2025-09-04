"use client";

import { useState, useEffect } from "react";
import { InfrastructureLogsTable } from "@/components/logs/infrastructure-logs/infrastructure-logs-table";
import { infrastructureLogColumns } from "@/components/logs/infrastructure-logs/columns";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { apiFetch } from "@/lib/utils";

export default function InfrastructureLogsPage(props) {
    const [logs, setLogs] = useState([]);
    const [infrastructures, setInfrastructures] = useState([]);
    const [deployments, setDeployments] = useState([]);
    const [selectedInfrastructure, setSelectedInfrastructure] = useState("all");
    const [selectedType, setSelectedType] = useState("all");
    const [loading, setLoading] = useState(true);
    const [projectId, setProjectId] = useState(null);

    useEffect(() => {
        const getParams = async () => {
            const params = await props.params;
            setProjectId(params.projectId);
        };
        getParams();
    }, [props.params]);

    const fetchLogs = async () => {
        if (!projectId) return;
        
        try {
            setLoading(true);
            
            const queryParams = new URLSearchParams({
                projectId: projectId,
                limit: "500",
            });

            if (selectedInfrastructure !== "all") {
                queryParams.append("infrastructureId", selectedInfrastructure);
            }

            if (selectedType !== "all") {
                queryParams.append("type", selectedType);
            }

            const logsData = await apiFetch(`/infrastructure-logs?${queryParams}`);
            setLogs(logsData || []);
        } catch (error) {
            console.error("Failed to fetch infrastructure logs:", error);
            setLogs([]);
        } finally {
            setLoading(false);
        }
    };

    const fetchInfrastructures = async () => {
        if (!projectId) return;
        
        try {
            const deploymentsData = await apiFetch(`/deployments?projectId=${projectId}`);
            setDeployments(deploymentsData || []);

            const allInfrastructures = [];
            for (const deployment of deploymentsData || []) {
                try {
                    const infraData = await apiFetch(`/deployments/${deployment.id}/infrastructure`);
                    allInfrastructures.push(
                        ...(infraData || []).map(infra => ({
                            ...infra,
                            deploymentName: deployment.name
                        }))
                    );
                } catch (error) {
                    console.error(`Failed to fetch infrastructure for deployment ${deployment.id}:`, error);
                }
            }
            setInfrastructures(allInfrastructures);
        } catch (error) {
            console.error("Failed to fetch deployments/infrastructure:", error);
        }
    };

    useEffect(() => {
        if (projectId) {
            fetchInfrastructures();
        }
    }, [projectId]);

    useEffect(() => {
        if (projectId) {
            fetchLogs();
        }
    }, [projectId, selectedInfrastructure, selectedType]);

    const handleRefresh = () => {
        fetchLogs();
    };

    if (!projectId) {
        return (
            <div className="p-6 h-screen w-full flex items-center justify-center">
                <div className="text-muted-foreground">Loading...</div>
            </div>
        );
    }

    return (
        <div className="p-6 h-screen w-full flex flex-col overflow-y-hidden gap-6">
            <Breadcrumb>
                <BreadcrumbList>
                    <BreadcrumbItem>
                        <BreadcrumbLink href={`/projects/${projectId}/overview`}>
                            Project
                        </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                        <BreadcrumbPage>Infrastructure Logs</BreadcrumbPage>
                    </BreadcrumbItem>
                </BreadcrumbList>
            </Breadcrumb>
            
            <Card className="overflow-hidden flex flex-col h-full w-full relative">
                <CardHeader>
                    <CardTitle className="text-2xl">Infrastructure Logs</CardTitle>
                    <p className="text-sm text-muted-foreground">
                        View logs from C2 servers and Redirectors
                    </p>
                </CardHeader>
                <CardContent className="flex-1 min-h-0 overflow-hidden max-w-full">
                    {loading ? (
                        <div className="flex items-center justify-center h-full">
                            <div className="text-muted-foreground">Loading logs...</div>
                        </div>
                    ) : (
                        <InfrastructureLogsTable
                            columns={infrastructureLogColumns}
                            data={logs}
                            infrastructures={infrastructures}
                            onInfrastructureChange={setSelectedInfrastructure}
                            onTypeChange={setSelectedType}
                            onRefresh={handleRefresh}
                            selectedInfrastructure={selectedInfrastructure}
                            selectedType={selectedType}
                        />
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
