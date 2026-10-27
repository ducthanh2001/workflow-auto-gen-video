"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ProjectView, type SceneView } from "@/lib/api";
import { LIGHTINGS, PROJECT_STATES } from "@vp/shared";
import { Badge, Button, Card, Empty, ErrorText } from "@/components/ui";
import { useScenes } from "@/lib/hooks";
import type { Actions } from "./actions";
import { ManualPlan } from "./ManualPlan";

const SHOTS = ["wide", "medium", "close", "detail"];
const LIGHTS = [...LIGHTINGS] as string[];
const CAMERAS = ["push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "tilt_down", "static"];
const MOTIONS = ["kenburns", "ai_clip"];
const TRANSITIONS = ["cut", "fade", "fadeblack", "dissolve"];

function VisualCell({ scene, actions }: { scene: SceneView; actions: Actions }) {
  const [text, setText] = useState(scene.visual);
  const dirty = text !== scene.visual;
  return (
    <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => dirty && text.trim().length >= 10 && actions.updateScene.mutate({ sceneId: scene.id, patch: { visual: text.trim() } })}
      className={`h-16 w-full min-w-56 text-xs ${dirty ? "outline outline-2 outline-amber-500" : ""}`}
      aria-label={`Visual for scene ${scene.idx + 1}`}
    />
  );
}

function Select({ value, options, onChange, label }: { value: string; options: string[]; onChange: (v: string) => void; label: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="text-xs" aria-label={label}>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

export function PlanPanel({ project, actions }: { project: ProjectView; actions: Actions }) {
  const scenes = useScenes(project.id);
  const verbatim = useQuery({
    queryKey: ["verbatim", project.id, scenes.data?.length ?? 0],
    queryFn: () => api.get<{ planned: boolean; ok?: boolean; diff?: string }>(`/projects/${project.id}/verbatim`),
    enabled: (scenes.data?.length ?? 0) > 0,
  });
  const idx = (s: string) => PROJECT_STATES.indexOf(s as never);
  const canPlan = idx(project.status) < idx("plan_approved");
  const hasScenes = (scenes.data?.length ?? 0) > 0;
  const editable = true;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Plan
          {hasScenes && <Badge>{scenes.data!.length} scenes</Badge>}
          {verbatim.data?.planned && (verbatim.data.ok ? <Badge tone="ok" title="Concatenated scene narration equals the script narration">Narration verbatim ✓</Badge> : <Badge tone="bad" title={verbatim.data.diff}>Narration differs from the script</Badge>)}
        </span>
      }
      actions={
        <>
          {canPlan && <Button variant="ghost" busy={actions.plan.isPending} onClick={() => actions.plan.mutate()}>{hasScenes ? "Re-plan" : "Create plan"}</Button>}
          {project.awaitingGate === "plan_approved" && (
            <Button busy={actions.approve.isPending} onClick={() => actions.approve.mutate("plan_approved")}>Approve plan & continue</Button>
          )}
        </>
      }
    >
      <ErrorText error={actions.plan.error ?? actions.approve.error} />
      {canPlan && <ManualPlan projectId={project.id} actions={actions} defaultOpen={!hasScenes} />}
      {project.meta.planWarnings && project.meta.planWarnings.length > 0 && (
        <details className="mb-3 text-sm">
          <summary className="cursor-pointer"><Badge tone="warn">{project.meta.planWarnings.length} plan warning(s)</Badge></summary>
          <ul className="mt-2 list-disc pl-5 text-[var(--muted)]">{project.meta.planWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      {!hasScenes && !scenes.isLoading && (
        <Empty>
          {project.activeJobs > 0 ? "Planning scenes… (this can take a minute for long scripts)" : "No plan yet. “Create plan” splits the script into scenes and describes a picture for each."}
        </Empty>
      )}
      {hasScenes && (
        <div className="max-h-[70vh] overflow-auto rounded border border-[var(--line)]">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-[var(--panel)] text-xs text-[var(--muted)]">
              <tr>
                <th className="p-2">#</th><th className="p-2">Narration (locked)</th><th className="p-2">Visual</th>
                <th className="p-2">Shot</th><th className="p-2" title="Light and time of day: fixes the colour palette of the picture">Light</th><th className="p-2">Camera</th><th className="p-2">Motion</th><th className="p-2">Out</th>
              </tr>
            </thead>
            <tbody>
              {scenes.data!.map((s, i, all) => (
                <tr key={s.id} className="border-t border-[var(--line)] align-top">
                  <td className="p-2 tabular-nums text-[var(--muted)]">{s.idx + 1}</td>
                  <td className="max-w-md p-2">
                    {(i === 0 || all[i - 1].beat !== s.beat) && <div className="mb-1"><Badge tone="info">{s.beat}</Badge></div>}
                    <span className="text-[var(--muted)]" title="Narration is read-only: it is a verbatim slice of your script">{s.narration}</span>
                  </td>
                  <td className="p-2">{editable ? <VisualCell scene={s} actions={actions} /> : s.visual}</td>
                  <td className="p-2"><Select label="shot" value={s.shot} options={SHOTS} onChange={(v) => actions.updateScene.mutate({ sceneId: s.id, patch: { shot: v } })} /></td>
                  <td className="p-2"><Select label="light" value={s.lighting} options={LIGHTS} onChange={(v) => actions.updateScene.mutate({ sceneId: s.id, patch: { lighting: v } })} /></td>
                  <td className="p-2"><Select label="camera" value={s.camera} options={CAMERAS} onChange={(v) => actions.updateScene.mutate({ sceneId: s.id, patch: { camera: v } })} /></td>
                  <td className="p-2"><Select label="motion" value={s.motion} options={MOTIONS} onChange={(v) => actions.updateScene.mutate({ sceneId: s.id, patch: { motion: v } })} /></td>
                  <td className="p-2"><Select label="transition out" value={s.transitionOut} options={TRANSITIONS} onChange={(v) => actions.updateScene.mutate({ sceneId: s.id, patch: { transitionOut: v } })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorText error={actions.updateScene.error} />
    </Card>
  );
}
