"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api, type ProjectView } from "@/lib/api";
import { STATE_LABEL, usd } from "@/lib/format";
import { Badge, Card, Empty } from "@/components/ui";

function tone(p: ProjectView) {
  if (p.status === "done") return "ok" as const;
  if (p.awaitingGate) return "warn" as const;
  if (p.activeJobs > 0) return "info" as const;
  return "neutral" as const;
}

export default function ProjectsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<ProjectView[]>("/projects"),
    refetchInterval: 5000,
  });

  return (
    <Card title="Projects">
      {isLoading && <Empty>Loading…</Empty>}
      {error && <p className="text-sm text-red-600">{(error as Error).message}</p>}
      {data && data.length === 0 && (
        <Empty>
          No projects yet. <Link href="/projects/new" className="text-[var(--accent)] underline">Create one from a script</Link>.
        </Empty>
      )}
      {data && data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-[var(--muted)]">
              <tr>
                <th className="py-2 pr-4 font-medium">Title</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Spent</th>
                <th className="py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} className="border-t border-[var(--line)]">
                  <td className="py-2 pr-4">
                    <Link href={`/projects/${p.id}`} className="font-medium hover:text-[var(--accent)]">{p.title}</Link>
                  </td>
                  <td className="py-2 pr-4">
                    <Badge tone={tone(p)}>{p.awaitingGate ? `Needs approval: ${p.awaitingGate.replace("_approved", "")}` : (STATE_LABEL[p.status] ?? p.status)}</Badge>
                    {p.activeJobs > 0 && <span className="ml-2 text-xs text-[var(--muted)]">{p.activeJobs} job(s) running</span>}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{usd(p.spentUsd)} / {usd(p.settings.maxUsdPerRun)}</td>
                  <td className="py-2 text-[var(--muted)]">{new Date(p.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
