"use client";

import {
    flexRender,
    getCoreRowModel,
    useReactTable,
    getPaginationRowModel,
    getSortedRowModel,
    getFilteredRowModel,
} from "@tanstack/react-table";

import { useState } from "react";
import { DataTableSearch } from "../logs-table/search";
import { LogTableFacetedFilters } from "../logs-table/log-filters";

import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

export function InfrastructureLogsTable({
    columns,
    data,
    infrastructures,
    onInfrastructureChange,
    onTypeChange,
    onRefresh,
    selectedInfrastructure,
    selectedType,
}) {
    const [sorting, setSorting] = useState([]);
    const [columnFilters, setColumnFilters] = useState([]);
    const [rowSelection, setRowSelection] = useState({});
    const [pagination, setPagination] = useState({
        pageIndex: 0,
        pageSize: 50,
    });

    const table = useReactTable({
        data,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        onPaginationChange: setPagination,
        onSortingChange: setSorting,
        getSortedRowModel: getSortedRowModel(),
        onColumnFiltersChange: setColumnFilters,
        getFilteredRowModel: getFilteredRowModel(),
        onRowSelectionChange: setRowSelection,
        state: {
            sorting,
            columnFilters,
            rowSelection,
            pagination,
        },
    });

    return (
        <div className="flex flex-col gap-4 w-full h-full overflow-hidden justify-between">
            <div className="flex flex-row justify-between items-center gap-4">
                <div className="flex gap-2 items-center">
                    <DataTableSearch
                        table={table}
                        column="message"
                        placeholder="Search logs..."
                    />
                    
                    <Select value={selectedInfrastructure} onValueChange={onInfrastructureChange}>
                        <SelectTrigger className="w-[200px]">
                            <SelectValue placeholder="All Infrastructure" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Infrastructure</SelectItem>
                            {infrastructures?.map((infra) => (
                                <SelectItem key={infra.id} value={infra.id}>
                                    {infra.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Select value={selectedType} onValueChange={onTypeChange}>
                        <SelectTrigger className="w-[120px]">
                            <SelectValue placeholder="All Types" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Types</SelectItem>
                            <SelectItem value="mythic">Mythic</SelectItem>
                            <SelectItem value="caddy">Caddy</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="flex gap-2">
                    <LogTableFacetedFilters table={table} />
                    <Button variant="outline" size="sm" onClick={onRefresh}>
                        <RefreshCw className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            <div className="rounded-md border overflow-y-auto overflow-x-auto flex-1 min-h-0 w-full">
                <Table>
                    <TableHeader className="sticky top-0">
                        {table.getHeaderGroups().map((headerGroup) => (
                            <TableRow key={headerGroup.id}>
                                {headerGroup.headers.map((header) => {
                                    return (
                                        <TableHead key={header.id}>
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(
                                                      header.column.columnDef.header,
                                                      header.getContext(),
                                                  )}
                                        </TableHead>
                                    );
                                })}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {table.getRowModel().rows?.length ? (
                            table.getRowModel().rows.map((row) => (
                                <TableRow
                                    key={row.id}
                                    data-state={row.getIsSelected() && "selected"}
                                >
                                    {row.getVisibleCells().map((cell) => (
                                        <TableCell key={cell.id}>
                                            {flexRender(
                                                cell.column.columnDef.cell,
                                                cell.getContext(),
                                            )}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        ) : (
                            <TableRow>
                                <TableCell
                                    colSpan={columns.length}
                                    className="text-center h-16"
                                >
                                    No infrastructure logs found.
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </div>

            <div className="flex items-center justify-between space-x-2 py-4">
                <div className="text-sm text-muted-foreground">
                    Showing {table.getFilteredRowModel().rows.length} of{" "}
                    {data.length} log entries
                </div>
                <div className="space-x-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => table.previousPage()}
                        disabled={!table.getCanPreviousPage()}
                    >
                        Previous
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => table.nextPage()}
                        disabled={!table.getCanNextPage()}
                    >
                        Next
                    </Button>
                </div>
            </div>
        </div>
    );
}