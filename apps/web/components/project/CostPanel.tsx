"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type MusicTrack, type ProjectView } from "@/lib/api";
import { useEstimate, useJobs } from "@/lib/hooks";
import { usd } from "@/lib/format";
import { Badge, Button, Card, ErrorText } from "@/components/ui";
import type { Actions } from "./actions";

export function CostPanel({ project, actions }: { project: ProjectView; actions: Actions }) {
  const est = useEstimate(project.id);
  const jobs = useJobs(project.id);
  const music = useQuery({ queryKey: ["music"], queryFn: () => api.get<MusicTrack[]>("/music") });
  const [cap, setCap] = useState(String(project.settings.maxUsdPerRun));

  const byStage = new Map<string, { cost: number; n: number; failed: number }>();
  for (const j of jobs.data ?? []) {
    const s = byStage.get(j.stage) ?? { cost: 0, n: 0, failed: 0 };
    s.cost += Number(j.costUsd);
    s.n++;
    if (j.status === "failed") s.failed++;
    byStage.set(j.stage, s);
  }
  const spent = project.spentUsd;
  const capUsd = project.settings.maxUsdPerRun;
  const pct = Math.min(100, (spent / capUsd) * 100);
  const E = est.data;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Spend versus cap">
        <div className="mb-1 flex justify-between text-sm">
          <span>{usd(spent)} spent</span>
          <span className="text-[var(--muted)]">cap {usd(capUsd)}</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded bg-[var(--hover)]" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full ${pct > 85 ? "bg-red-500" : pct > 60 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
        </div>
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs text-[var(--muted)]"><tr><th className="py-1">Stage</th><th>Jobs</th><th className="text-right">Cost</th></tr></thead>
          <tbody>
            {[...byStage.entries()].map(([stage, s]) => (
              <tr key={stage} className="border-t border-[var(--line)]">
                <td className="py-1">{stage}</td>
                <td>{s.n}{s.failed > 0 && <Badge tone="bad">{s.failed} failed</Badge>}</td>
                <td className="text-right tabular-nums">{usd(s.cost)}</td>
              </tr>
            ))}
            {byStage.size === 0 && <tr><td colSpan={3} className="py-3 text-[var(--muted)]">Nothing has been spent yet.</td></tr>}
          </tbody>
        </table>
      </Card>

      <Card title={E ? `Estimate for the whole run (${E.basedOn === "plan" ? "from the plan" : "from the script length"})` : "Estimate"}>
        {E && (
          <>
            <table className="w-full text-sm">
              <tbody>
                {([["Planning", E.plan], ["References", E.refs], [`Voice (${E.ttsChars.toLocaleString()} characters)`, E.tts], [`Images (${E.scenes})`, E.images], [`AI clips (${E.aiClips})`, E.clips], ["Thumbnails", E.thumbnails]] as const).map(([k, v]) => (
                  <tr key={k} className="border-t border-[var(--line)] first:border-t-0"><td className="py-1">{k}</td><td className="text-right tabular-nums">{usd(v)}</td></tr>
                ))}
                <tr className="border-t-2 border-[var(--line)] font-semibold"><td className="py-1">Total</td><td className="text-right tabular-nums">{usd(E.total)}</td></tr>
              </tbody>
            </table>
            {E.total + E.spentUsd > E.capUsd && <p className="mt-2 text-sm text-red-600">This is above the cap. Raise the cap below or the run will stop before it gets there.</p>}
            <p className="mt-2 text-xs text-[var(--muted)]">Prices come from <code>config/pricing.json</code>; verify them on the providers’ pricing pages.</p>
          </>
        )}
      </Card>

      <Card title="Project settings" className="lg:col-span-2">
        <ErrorText error={actions.settings.error} />
        <div className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-[var(--muted)]">Budget cap per run (USD)</span>
            <div className="flex gap-2">
              <input type="number" min={1} step={1} value={cap} onChange={(e) => setCap(e.target.value)} className="w-24" />
              <Button variant="ghost" disabled={Number(cap) <= 0 || Number(cap) === capUsd} onClick={() => actions.settings.mutate({ maxUsdPerRun: Number(cap) })}>Save</Button>
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--muted)]">AI motion clips: max share of scenes</span>
            <select value={String(project.settings.maxAiClipShare)} onChange={(e) => actions.settings.mutate({ maxAiClipShare: Number(e.target.value) })} className="w-full">
              <option value="0">Off (Ken Burns only)</option>
              <option value="0.1">10%</option>
              <option value="0.15">15% (default)</option>
              <option value="0.25">25%</option>
            </select>
          </label>
          <label className="flex items-center gap-2 self-end pb-1">
            <input type="checkbox" checked={project.settings.captions} onChange={(e) => actions.settings.mutate({ captions: e.target.checked })} />
            <span>Burn captions into the video <span className="text-[var(--muted)]">(the .srt is always exported)</span></span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--muted)]">Background music</span>
            <select value={project.settings.musicTrackId ?? ""} onChange={(e) => actions.settings.mutate({ musicTrackId: e.target.value || null })} className="w-full">
              <option value="">None</option>
              {music.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {music.data?.length === 0 && <span className="text-xs text-[var(--muted)]">Add a licensed track on the Music page.</span>}
          </label>
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">Changing captions or music marks the draft and final as out of date.</p>
      </Card>
    </div>
  );
}
