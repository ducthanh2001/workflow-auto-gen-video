"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ProjectView, SceneView } from "@/lib/api";
import { useScenePrompt, useScenes } from "@/lib/hooks";
import { mmss } from "@/lib/format";
import { Badge, Button, Card, Empty, ErrorText } from "@/components/ui";
import type { Actions } from "./actions";

const ROW = 140;

function PlayButton({ url }: { url: string }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <>
      <audio ref={ref} src={`/api${url}`} preload="none" onEnded={() => setPlaying(false)} onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} />
      <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => (playing ? ref.current?.pause() : void ref.current?.play())} aria-label={playing ? "Pause narration" : "Play narration"}>
        {playing ? "⏸ Pause" : "▶ Play"}
      </Button>
    </>
  );
}

function copy(text: string) {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard may be blocked; the text is selectable in the dialog */
  }
}

/** The text prompt and reference pictures one image call uses, so a picture can be made by hand elsewhere. */
function PromptDialog({ scene, onClose }: { scene: SceneView; onClose: () => void }) {
  const q = useScenePrompt(scene.id);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const d = q.data;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose} role="presentation">
      <div
        role="dialog" aria-modal="true" aria-label={`Image prompt for scene ${scene.idx + 1}`}
        className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-lg border border-[var(--line)] bg-[var(--panel)] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Image prompt · scene {scene.idx + 1}</h3>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onClose}>Close</Button>
        </div>
        {q.isLoading && <p className="text-sm text-[var(--muted)]">Loading…</p>}
        <ErrorText error={q.error} />
        {d && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-1.5 text-xs">
              <Badge>style: {d.style}</Badge>
              <Badge>model: {d.model}</Badge>
              <Badge tone={d.hasPeople ? "info" : "neutral"}>{d.hasPeople ? "shows people" : "no people"}</Badge>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium">Prompt</span>
                <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => copy(d.prompt)}>Copy</Button>
              </div>
              <pre className="whitespace-pre-wrap rounded border border-[var(--line)] bg-[var(--hover)] p-2 text-xs">{d.prompt}</pre>
            </div>
            <div>
              <span className="font-medium">Reference pictures sent with it: </span>
              {d.references.join(" + ")}
              <p className="mt-1 text-xs text-[var(--muted)]">
                The character sheet and the chosen style anchor are in the References tab. If you make this picture elsewhere, attach the same references so the character matches.
              </p>
            </div>
            {d.lastError && <p className="text-xs text-red-600">Last error: {d.lastError}</p>}
            <details>
              <summary className="cursor-pointer text-xs text-[var(--muted)]">Stricter prompt used for the automatic retry (when text appears in the picture)</summary>
              <pre className="mt-1 whitespace-pre-wrap rounded border border-[var(--line)] bg-[var(--hover)] p-2 text-xs">{d.retryPrompt}</pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

function SceneRow({ s, actions, busy, onViewPrompt }: { s: SceneView; actions: Actions; busy: boolean; onViewPrompt: (s: SceneView) => void }) {
  const regen = (stage: "voice" | "image" | "clip") => actions.regenerate.mutate({ sceneId: s.id, stage });
  const uploading = actions.uploadSceneImage.isPending && actions.uploadSceneImage.variables?.sceneId === s.id;
  return (
    <div className="flex h-full gap-3 border-b border-[var(--line)] p-2">
      <div className="relative aspect-video h-[124px] shrink-0 overflow-hidden rounded bg-[var(--hover)]">
        {s.imageUrl ? <img src={`/api${s.imageUrl}`} alt={`Scene ${s.idx + 1}`} loading="lazy" className="h-full w-full object-cover" /> : (
          <div className="flex h-full items-center justify-center text-xs text-[var(--muted)]">no image</div>
        )}
        <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-xs text-white">{s.idx + 1}</span>
      </div>
      <div className="min-w-0 flex-1 text-sm">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <Badge tone="info">{s.beat}</Badge>
          {s.status === "ready" && <Badge tone="ok">ready</Badge>}
          {s.status === "failed" && <Badge tone="bad" title={s.error ?? undefined}>failed</Badge>}
          {s.status === "pending" && <Badge>pending</Badge>}
          {s.stale && <Badge tone="warn" title="Changed since the last render">stale</Badge>}
          <Badge title="Motion">{s.motion === "ai_clip" ? (s.clipUrl ? "AI clip ✓" : "AI clip") : "Ken Burns"} · {s.camera}</Badge>
          <span className="text-xs text-[var(--muted)]">{s.audioDurationSec ? `${s.audioDurationSec.toFixed(1)}s` : "no audio"}</span>
        </div>
        <p className="line-clamp-2">{s.narration}</p>
        {s.error && <p className="mt-1 line-clamp-2 text-xs text-red-600" title={s.error}>{s.error}</p>}
      </div>
      <div className="flex shrink-0 flex-col items-end justify-center gap-1">
        {s.audioUrl && <PlayButton url={s.audioUrl} />}
        <div className="flex gap-1">
          <Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => regen("voice")}>Redo voice</Button>
          <Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => regen("image")}>Redo image</Button>
          {s.motion === "ai_clip" && <Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => regen("clip")}>Redo clip</Button>}
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => onViewPrompt(s)}>View prompt</Button>
          <label
            className={`inline-flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1 text-xs font-medium transition ${
              s.imageUrl ? "border-[var(--line)] bg-[var(--panel)] hover:bg-[var(--hover)]" : "border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--hover)]"
            } ${uploading ? "pointer-events-none opacity-50" : ""}`}
            title="Use your own picture for this scene (PNG, JPEG or WebP). It is cropped to 16:9."
          >
            {uploading ? "Uploading…" : s.imageUrl ? "Replace image" : "Upload image"}
            <input
              type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ""; // allow choosing the same file again
                if (file) actions.uploadSceneImage.mutate({ sceneId: s.id, file });
              }}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

export function ScenesPanel({ project, actions }: { project: ProjectView; actions: Actions }) {
  const scenes = useScenes(project.id);
  const parent = useRef<HTMLDivElement>(null);
  const [promptFor, setPromptFor] = useState<SceneView | null>(null);
  const data = scenes.data ?? [];
  const virt = useVirtualizer({ count: data.length, getScrollElement: () => parent.current, estimateSize: () => ROW, overscan: 6 });

  const noAudio = data.filter((s) => !s.audioUrl).length;
  const noImage = data.filter((s) => !s.imageUrl).length;
  const failed = data.filter((s) => s.status === "failed").length;
  const busy = project.activeJobs > 0;

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Scenes <Badge>{data.length}</Badge>
          {failed > 0 && <Badge tone="bad">{failed} failed</Badge>}
          {busy && <Badge tone="info">{project.activeJobs} job(s) running</Badge>}
        </span>
      }
      actions={
        <>
          {failed > 0 && !busy && <Button variant="ghost" busy={actions.retry.isPending} onClick={() => actions.retry.mutate()}>Retry failed</Button>}
          <Button variant="ghost" disabled={busy || !noAudio} onClick={() => actions.stage.mutate("voice")}>Voice missing ({noAudio})</Button>
          <Button variant="ghost" disabled={busy || !noImage || !project.styleAnchorAssetId} onClick={() => actions.stage.mutate("images")}>Images missing ({noImage})</Button>
          {project.awaitingGate === "images_approved" && (
            <Button busy={actions.approve.isPending} onClick={() => actions.approve.mutate("images_approved")}>Approve images & continue</Button>
          )}
        </>
      }
    >
      <ErrorText error={actions.stage.error ?? actions.regenerate.error ?? actions.retry.error ?? actions.approve.error ?? actions.uploadSceneImage.error} />
      {promptFor && <PromptDialog scene={promptFor} onClose={() => setPromptFor(null)} />}
      {data.length === 0 ? (
        <Empty>No scenes yet. Create and approve the plan first.</Empty>
      ) : (
        <div ref={parent} className="h-[70vh] overflow-auto rounded border border-[var(--line)]">
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((v) => (
              <div key={data[v.index].id} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: ROW, transform: `translateY(${v.start}px)` }}>
                <SceneRow s={data[v.index]} actions={actions} busy={busy} onViewPrompt={setPromptFor} />
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-[var(--muted)]">
        Total narration {mmss(data.reduce((a, s) => a + (s.audioDurationSec ?? 0), 0))}. Redoing a scene marks the render stale; render the draft again to see it.
      </p>
    </Card>
  );
}
