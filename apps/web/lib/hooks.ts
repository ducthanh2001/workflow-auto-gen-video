"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Estimate, type GlobalHeroStatus, type JobView, type Output, type ProjectView, type RefsView, type ScenePrompt, type SceneView, type TimelineView } from "./api";

export const useProject = (id: string) =>
  useQuery({
    queryKey: ["project", id],
    queryFn: () => api.get<ProjectView>(`/projects/${id}`),
    refetchInterval: (q) => (q.state.data && q.state.data.activeJobs > 0 ? 3000 : false),
  });

export const useScenes = (id: string, enabled = true) =>
  useQuery({ queryKey: ["scenes", id], queryFn: () => api.get<SceneView[]>(`/projects/${id}/scenes`), enabled });

/** The image prompt of one scene; only fetched while its dialog is open. */
export const useScenePrompt = (sceneId: string | null) =>
  useQuery({ queryKey: ["scene-prompt", sceneId], queryFn: () => api.get<ScenePrompt>(`/scenes/${sceneId}/prompt`), enabled: !!sceneId });

export const useOutputs =(id: string) => useQuery({ queryKey: ["outputs", id], queryFn: () => api.get<Output[]>(`/projects/${id}/outputs`) });
export const useGlobalHero = () => useQuery({ queryKey: ["global-hero"], queryFn: () => api.get<GlobalHeroStatus>("/global-hero") });
export const useRefs = (id: string) => useQuery({ queryKey: ["refs", id], queryFn: () => api.get<RefsView>(`/projects/${id}/refs`) });
export const useTimeline = (id: string) => useQuery({ queryKey: ["timeline", id], queryFn: () => api.get<TimelineView>(`/projects/${id}/timeline`) });
export const useJobs = (id: string) => useQuery({ queryKey: ["jobs", id], queryFn: () => api.get<JobView[]>(`/projects/${id}/jobs`) });
export const useEstimate = (id: string) => useQuery({ queryKey: ["estimate", id], queryFn: () => api.get<Estimate>(`/projects/${id}/estimate`) });

export interface LiveNotice {
  kind: "blocked" | "gate" | "error";
  message: string;
}

/**
 * Subscribes to the project's SSE stream and refreshes the cached queries on every event.
 * Returns the latest notice (blocked stage, gate waiting, job error) for the banner.
 */
export function useProjectEvents(id: string): LiveNotice | null {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<LiveNotice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/projects/${id}/events`);
    const refresh = () => {
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        for (const k of ["project", "scenes", "outputs", "refs", "timeline", "jobs", "estimate"]) void qc.invalidateQueries({ queryKey: [k, id] });
      }, 250);
    };
    const onEvent = (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data) as { type: string; data: Record<string, unknown> };
        if (ev.type === "state") {
          const d = ev.data as { blocked?: string; message?: string; awaitingGate?: string };
          if (d.blocked) setNotice({ kind: "blocked", message: d.message ?? `${d.blocked} is blocked` });
          else if (d.awaitingGate) setNotice({ kind: "gate", message: `Waiting for your approval: ${d.awaitingGate.replace("_", " ")}` });
          else setNotice(null);
        }
        if (ev.type === "job" && ev.data.status === "failed") setNotice({ kind: "error", message: String(ev.data.error ?? "a job failed") });
      } catch {
        /* ignore */
      }
      refresh();
    };
    for (const t of ["job", "state", "asset"]) es.addEventListener(t, onEvent as EventListener);
    return () => {
      es.close();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [id, qc]);

  return notice;
}
