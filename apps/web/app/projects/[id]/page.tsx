"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PROJECT_STATES } from "@vp/shared";
import { useProject, useProjectEvents, useScenes } from "@/lib/hooks";
import { GATE_LABEL, STATE_LABEL, usd } from "@/lib/format";
import { Badge, Button, Spinner } from "@/components/ui";
import { useActions } from "@/components/project/actions";
import { PlanPanel } from "@/components/project/PlanPanel";
import { RefsPanel } from "@/components/project/RefsPanel";
import { ScenesPanel } from "@/components/project/ScenesPanel";
import { DraftPanel } from "@/components/project/DraftPanel";
import { FinalPanel } from "@/components/project/FinalPanel";
import { ThumbsPanel } from "@/components/project/ThumbsPanel";
import { CostPanel } from "@/components/project/CostPanel";

const TABS = [
  { key: "plan", label: "1 · Plan" },
  { key: "refs", label: "2 · References" },
  { key: "scenes", label: "3 · Scenes" },
  { key: "draft", label: "4 · Draft" },
  { key: "final", label: "5 · Final" },
  { key: "thumbs", label: "6 · Thumbnails" },
  { key: "cost", label: "Cost & settings" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/** Which tab the project is currently "at", so a freshly opened page lands where the work is. */
function tabForStatus(status: string): Tab {
  const i = PROJECT_STATES.indexOf(status as never);
  if (i < PROJECT_STATES.indexOf("plan_approved")) return "plan";
  if (i < PROJECT_STATES.indexOf("refs_approved")) return "refs";
  if (i < PROJECT_STATES.indexOf("images_approved")) return "scenes";
  if (i < PROJECT_STATES.indexOf("draft_approved")) return "draft";
  if (i < PROJECT_STATES.indexOf("thumbnails_ready")) return "final";
  return "thumbs";
}

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const project = useProject(id);
  const notice = useProjectEvents(id);
  const actions = useActions(id);
  const scenes = useScenes(id);
  const [tab, setTab] = useState<Tab | null>(null);

  const p = project.data;
  useEffect(() => {
    if (p && tab === null) setTab(tabForStatus(p.status));
  }, [p, tab]);

  if (project.isLoading) return <p className="text-sm text-[var(--muted)]">Loading…</p>;
  if (project.error || !p) return <p className="text-sm text-red-600">{(project.error as Error)?.message ?? "Project not found"} · <Link href="/" className="underline">back to projects</Link></p>;

  const failed = (scenes.data ?? []).filter((s) => s.status === "failed").length;
  const busy = p.activeJobs > 0;
  const running = busy || actions.run.isPending;
  const done = p.status === "done";
  const active = tab ?? tabForStatus(p.status);
  const cappedPct = Math.min(100, (p.spentUsd / p.settings.maxUsdPerRun) * 100);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{p.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={done ? "ok" : p.awaitingGate ? "warn" : busy ? "info" : "neutral"}>{STATE_LABEL[p.status] ?? p.status}</Badge>
            {busy && <span className="inline-flex items-center gap-1 text-[var(--muted)]"><Spinner /> {p.activeJobs} job(s) running</span>}
            {p.stale.length > 0 && <Badge tone="warn">{p.stale.join(" and ")} out of date</Badge>}
            <span className="text-[var(--muted)]">{usd(p.spentUsd)} of {usd(p.settings.maxUsdPerRun)}</span>
            <span className="h-1.5 w-24 overflow-hidden rounded bg-[var(--hover)]"><span className="block h-full bg-[var(--accent)]" style={{ width: `${cappedPct}%` }} /></span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {failed > 0 && !busy && <Button variant="ghost" busy={actions.retry.isPending} onClick={() => actions.retry.mutate()}>Retry {failed} failed</Button>}
          {p.awaitingGate ? (
            <Button disabled={p.awaitingGate === "refs_approved" && !p.styleAnchorAssetId} busy={actions.approve.isPending} onClick={() => actions.approve.mutate(p.awaitingGate!)}>
              Approve {GATE_LABEL[p.awaitingGate]} & continue
            </Button>
          ) : (
            !done && <Button busy={running} onClick={() => actions.run.mutate()}>{p.status === "parsed" ? "Start: create plan" : "Run to next approval"}</Button>
          )}
          <Button
            variant="danger"
            onClick={() => confirm(`Delete “${p.title}” and everything generated for it?`) && actions.remove.mutate(undefined, { onSuccess: () => router.push("/") })}
          >
            Delete
          </Button>
        </div>
      </div>

      {notice && (
        <div role="status" className={`rounded-md border px-3 py-2 text-sm ${notice.kind === "gate" ? "border-amber-500/40 bg-amber-500/10" : "border-red-500/40 bg-red-500/10"}`}>
          {notice.message}
        </div>
      )}
      {actions.run.error && <p className="text-sm text-red-600">{(actions.run.error as Error).message}</p>}
      {actions.approve.error && <p className="text-sm text-red-600">{(actions.approve.error as Error).message}</p>}
      {p.meta.warnings && p.meta.warnings.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">{p.meta.warnings.join(" ")}</div>
      )}

      <nav className="flex flex-wrap gap-1 border-b border-[var(--line)]" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={active === t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${active === t.key ? "border-[var(--accent)] font-semibold" : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {active === "plan" && <PlanPanel project={p} actions={actions} />}
      {active === "refs" && <RefsPanel project={p} actions={actions} />}
      {active === "scenes" && <ScenesPanel project={p} actions={actions} />}
      {active === "draft" && <DraftPanel project={p} actions={actions} />}
      {active === "final" && <FinalPanel project={p} actions={actions} />}
      {active === "thumbs" && <ThumbsPanel project={p} actions={actions} />}
      {active === "cost" && <CostPanel project={p} actions={actions} />}
    </div>
  );
}
