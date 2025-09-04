"use client";

import { DataTableColumnHeader } from "../logs-table/column-header";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { Tag } from "@/components/common/tag";

export const infrastructureLogColumns = [
    {
        accessorKey: "type",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Type" />
        ),
        cell: ({ row }) => {
            const type = row.original?.type;
            const color = type === "mythic" ? "blue" : type === "caddy" ? "green" : "gray";
            return <Tag color={color}>{type}</Tag>;
        },
    },
    {
        accessorKey: "timestamp",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Timestamp" />
        ),
        cell: ({ row }) => (
            <p className="min-w-[185px]">
                {new Date(row.original?.timestamp).toLocaleString()}
            </p>
        ),
    },
    {
        accessorKey: "level",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Level" />
        ),
        cell: ({ row }) => {
            const level = row.getValue("level");
            const type = row.original?.type;

            let color = "gray";
            if (type === "caddy") {
                switch (level) {
                    case "error":
                        color = "red";
                        break;
                    case "warning":
                        color = "amber";
                        break;
                    case "info":
                        color = "blue";
                        break;
                }
            } else if (type === "mythic") {
                switch (level) {
                    case "task_new":
                    case "task_completed":
                        color = "blue";
                        break;
                    case "callback_new":
                        color = "green";
                        break;
                    case "artifact_new":
                    case "file_upload":
                        color = "purple";
                        break;
                    case "eventlog_new":
                        color = "amber";
                        break;
                    default:
                        color = "gray";
                }
            }

            return (
                <Tag className="self-start" color={color}>
                    {level}
                </Tag>
            );
        },
    },
    {
        accessorKey: "message",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Message" />
        ),
        cell: ({ row }) => (
            <div className="max-w-[1000px] text-overflow-x-wrap">
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger>
                            <p className="font-mono line-clamp-3 text-left max-w-[1000px]">
                                {row.original?.message}
                            </p>
                        </TooltipTrigger>
                        <TooltipContent>
                            <div className="max-w-[600px]">
                                <p className="font-mono mb-2">{row.original?.message}</p>
                                {row.original?.rawData && (
                                    <details>
                                        <summary className="cursor-pointer text-sm text-muted-foreground">
                                            Raw Data
                                        </summary>
                                        <pre className="text-xs mt-2 p-2 bg-muted rounded overflow-auto max-h-48">
                                            {JSON.stringify(row.original.rawData, null, 2)}
                                        </pre>
                                    </details>
                                )}
                            </div>
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            </div>
        ),
    },
];