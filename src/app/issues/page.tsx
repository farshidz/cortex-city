"use client";

import useSWR from "swr";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Issue, IssuePriority, IssueStatus } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const PAGE_SIZE = 25;

const STATUS_COLORS: Record<IssueStatus, string> = {
  open: "bg-blue-100 text-blue-800",
  in_progress: "bg-yellow-100 text-yellow-800",
  done: "bg-green-100 text-green-800",
  closed: "bg-gray-100 text-gray-800",
};

const PRIORITY_COLORS: Record<IssuePriority, string> = {
  high: "bg-red-500",
  medium: "bg-yellow-500",
  low: "bg-green-500",
};

interface IssueListResponse {
  items: Issue[];
  total: number;
  page: number;
  page_size: number;
}

export default function IssuesPage() {
  const [page, setPage] = useState(1);
  const [showResolved, setShowResolved] = useState(false);
  const query = new URLSearchParams({
    show_resolved: String(showResolved),
    page: String(page),
    page_size: String(PAGE_SIZE),
  }).toString();
  const { data } = useSWR<IssueListResponse>(`/api/issues?${query}`, fetcher, {
    refreshInterval: 5000,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.page_size ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Issues</h1>
        <Link href="/issues/new">
          <Button>New Issue</Button>
        </Link>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <Switch
          checked={showResolved}
          onCheckedChange={(checked) => {
            setShowResolved(checked);
            setPage(1);
          }}
        />
        <span className="text-sm">Show resolved</span>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[12px] p-0" aria-label="Priority" />
            <TableHead className="w-[80px]">ID</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Task</TableHead>
            <TableHead>Comments</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((issue) => (
            <TableRow key={issue.id}>
              <TableCell className="p-0 w-[12px]">
                {issue.priority ? (
                  <span
                    aria-label={`priority ${issue.priority}`}
                    title={`priority: ${issue.priority}`}
                    className={`block h-full w-1.5 rounded-sm ${PRIORITY_COLORS[issue.priority]}`}
                    style={{ minHeight: "1.5rem" }}
                  />
                ) : null}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {issue.id.slice(0, 8)}
              </TableCell>
              <TableCell>
                <Link
                  href={`/issues/${issue.id}`}
                  className="hover:underline font-medium"
                >
                  {issue.title}
                </Link>
              </TableCell>
              <TableCell>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[issue.status]}`}
                >
                  {issue.status.replace("_", " ")}
                </span>
              </TableCell>
              <TableCell>
                {issue.task_id ? (
                  <Link
                    href={`/tasks/${issue.task_id}`}
                    className="font-mono text-xs hover:underline"
                  >
                    {issue.task_id.slice(0, 8)}
                  </Link>
                ) : (
                  <span className="text-muted-foreground text-xs">—</span>
                )}
              </TableCell>
              <TableCell className="text-sm">{issue.comments.length}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {new Date(issue.updated_at).toLocaleString()}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {new Date(issue.created_at).toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
          {items.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={8}
                className="text-center text-muted-foreground py-8"
              >
                No issues.{" "}
                <Link href="/issues/new" className="underline">
                  Create one
                </Link>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between mt-4 text-sm">
        <span className="text-muted-foreground">
          {total} {total === 1 ? "issue" : "issues"}
          {!showResolved && " (resolved hidden)"}
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </Button>
          <span className="text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
