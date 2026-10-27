"use client";
import { useRef, useState } from "react";
import type { ProjectView } from "@/lib/api";
import { useOutputs, useTimeline } from "@/lib/hooks";
import { mmss } from "@/lib/format";
import { Badge, Button, Card, Empty, ErrorText } from "@/components/ui";
import type { Actions } from "./actions";

/** Player with scene and chapter markers on the progress bar. */
export function DraftPanel({ project, actions }: { project: ProjectView; actions: Actions }) {
  const outputs = useOutputs(project.id);
  const timeline = useTimeline(project.id);
  const video = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const draft = outputs.data?.find((o) => o.type === "video" && o.kind === "draft");
  const tl = timeline.data;
  const total = tl?.totalSec || video.current?.duration || 0;
  const seek = (t: number) => {
    if (video.current) {
      video.current.currentTime = Math.max(0, t);
      void video.current.play();
    }
  };
  const stale = project.stale.includes("draft");
  const rendering = project.activeJobs > 0 && project.nextStage === "render_draft";

  return (
    <Card
      title={<span className="flex items-center gap-2">Draft preview (960×540) {draft && (stale ? <Badge tone="warn">out of date</Badge> : <Badge tone="ok">up to date</Badge>)}</span>}
      actions={
        <>
          <Button variant="ghost" busy={actions.render.isPending || rendering} onClick={() => actions.render.mutate("draft")}>{draft ? "Render draft again" : "Render draft"}</Button>
          {project.awaitingGate === "draft_approved" && (
            <Button disabled={stale} busy={actions.approve.isPending} onClick={() => actions.approve.mutate("draft_approved")} title={stale ? "Render the draft again first" : undefined}>
              Approve draft & render final
            </Button>
          )}
        </>
      }
    >
      <ErrorText error={actions.render.error ?? actions.approve.error} />
      {!draft && <Empty>{rendering ? "Rendering the draft…" : "No draft yet. It renders automatically after the images are approved, or press “Render draft”."}</Empty>}
      {draft && (
        <div className="space-y-2">
          <video
            key={draft.id}
            ref={video}
            src={`/api${draft.url}`}
            controls
            preload="metadata"
            className="aspect-video w-full max-w-4xl rounded bg-black"
            onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
          />
          {tl?.ready && total > 0 && (
            <div className="max-w-4xl">
              <div className="relative h-7 rounded bg-[var(--hover)]" role="group" aria-label="Scene markers">
                {tl.scenes.map((s) => (
                  <button
                    key={s.idx}
                    onClick={() => seek(s.startSec)}
                    title={`Scene ${s.idx + 1} · ${s.beat} · ${mmss(s.startSec)}`}
                    className="absolute top-0 h-full w-px bg-[var(--muted)]/50 hover:w-1 hover:bg-[var(--accent)]"
                    style={{ left: `${(s.startSec / total) * 100}%` }}
                  />
                ))}
                {tl.chapters.map((c) => (
                  <button
                    key={c.title + c.startSec}
                    onClick={() => seek(c.startSec)}
                    title={`Chapter: ${c.title} · ${mmss(c.startSec)}`}
                    className="absolute top-0 h-full w-0.5 bg-[var(--accent)]"
                    style={{ left: `${(c.startSec / total) * 100}%` }}
                  />
                ))}
                <div className="pointer-events-none absolute top-0 h-full w-0.5 bg-sky-500" style={{ left: `${Math.min(100, (now / total) * 100)}%` }} />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-[var(--muted)]">
                <span>Thin lines: scenes · orange: chapters (beats)</span>
                {tl.chapters.map((c) => (
                  <button key={c.title + c.startSec} onClick={() => seek(c.startSec)} className="underline-offset-2 hover:underline">{mmss(c.startSec)} {c.title}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
