"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Gate } from "@vp/shared";
import { api } from "@/lib/api";

/** All the buttons' mutations in one place; each refreshes everything the project page shows. */
export function useActions(id: string) {
  const qc = useQueryClient();
  const refresh = () => {
    for (const k of ["project", "scenes", "outputs", "refs", "timeline", "jobs", "estimate", "verbatim", "projects"]) {
      void qc.invalidateQueries({ queryKey: [k, id] });
    }
    void qc.invalidateQueries({ queryKey: ["projects"] });
    void qc.invalidateQueries({ queryKey: ["global-hero"] });
  };
  const opts = { onSuccess: refresh, onError: refresh };

  return {
    /** Start (or continue) the run. It stops at every approval gate. */
    run: useMutation({ mutationFn: () => api.post(`/projects/${id}/run`, { to: "done" }), ...opts }),
    /** Approve a gate and let the run carry on to the next one. */
    approve: useMutation({
      mutationFn: async (gate: Gate) => {
        await api.post(`/projects/${id}/run`, { to: "done" });
        return api.post(`/projects/${id}/approve/${gate}`);
      },
      ...opts,
    }),
    plan: useMutation({ mutationFn: () => api.post(`/projects/${id}/plan`), ...opts }),
    /** Plan made outside the app (e.g. in Claude desktop): validated like the API planner's output. */
    importPlan: useMutation({
      mutationFn: (text: string) => api.post<{ scenes: number; warnings: string[] }>(`/projects/${id}/plan/import`, { text }),
      ...opts,
    }),
    retry: useMutation({ mutationFn: () => api.post(`/projects/${id}/retry`), ...opts }),
    refs: useMutation({ mutationFn: () => api.post(`/projects/${id}/refs`), ...opts }),
    selectRefs: useMutation({
      mutationFn: (v: { anchorAssetId: string; characterSheetAssetId?: string }) => api.post(`/projects/${id}/refs/select`, v),
      ...opts,
    }),
    uploadSheet: useMutation({
      mutationFn: (file: File) => {
        const fd = new FormData();
        fd.append("file", file);
        return api.upload(`/projects/${id}/refs/character-sheet`, fd);
      },
      ...opts,
    }),
    /** Make a sheet of this project the hero of EVERY project created from now on. */
    saveGlobal: useMutation({
      mutationFn: (v: { kind: "sheet" | "modern" | "anchor"; assetId?: string }) => api.post(`/projects/${id}/refs/save-global`, v),
      ...opts,
    }),
    /** Swap this project's hero for the saved global one (free). */
    useGlobal: useMutation({ mutationFn: () => api.post(`/projects/${id}/refs/use-global`), ...opts }),
    /** Draw the modern-outfit hero sheet (one image) from this project's hero sheet. */
    modernSheet: useMutation({ mutationFn: () => api.post(`/projects/${id}/refs/modern-sheet`), ...opts }),
    /** Store a picture as the global hero reference frame (used to draw a new sheet), sheet or modern sheet. */
    uploadGlobal: useMutation({
      mutationFn: async (v: { kind: "sheet" | "modern" | "reference" | "anchor"; file: File }) => {
        const fd = new FormData();
        fd.append("file", v.file);
        const saved = await api.upload(`/global-hero/${v.kind}`, fd);
        // a new hero sheet is useful at once: this project (still choosing its references) takes it over too
        if (v.kind !== "reference") await api.post(`/projects/${id}/refs/use-global`).catch(() => undefined);
        return saved;
      },
      ...opts,
    }),
    stage: useMutation({ mutationFn: (s: "voice" | "images" | "motion") => api.post(`/projects/${id}/${s}`), ...opts }),
    regenerate: useMutation({
      mutationFn: (v: { sceneId: string; stage: "voice" | "image" | "clip" }) => api.post(`/scenes/${v.sceneId}/regenerate/${v.stage}`),
      ...opts,
    }),
    /** Use your own picture for a scene (e.g. generation failed or the credits ran out). */
    uploadSceneImage: useMutation({
      mutationFn: (v: { sceneId: string; file: File }) => {
        const fd = new FormData();
        fd.append("file", v.file);
        return api.upload(`/scenes/${v.sceneId}/image/upload`, fd);
      },
      ...opts,
    }),
    render: useMutation({ mutationFn: (mode: "draft" | "final") => api.post(`/projects/${id}/render`, { mode }), ...opts }),
    thumbnails: useMutation({ mutationFn: () => api.post(`/projects/${id}/thumbnails`), ...opts }),
    metadata: useMutation({ mutationFn: () => api.post(`/projects/${id}/metadata`), ...opts }),
    updateScene: useMutation({
      mutationFn: (v: { sceneId: string; patch: Record<string, unknown> }) => api.patch(`/scenes/${v.sceneId}`, v.patch),
      ...opts,
    }),
    settings: useMutation({ mutationFn: (patch: Record<string, unknown>) => api.patch(`/projects/${id}/settings`, patch), ...opts }),
    remove: useMutation({ mutationFn: () => api.del(`/projects/${id}`) }),
  };
}

export type Actions = ReturnType<typeof useActions>;
