"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import type { ProjectView } from "@/lib/api";
import { useOutputs } from "@/lib/hooks";
import { Badge, Button, Card, Empty, ErrorText } from "@/components/ui";
import type { Actions } from "./actions";

interface Check { contrast: number; textWidthRatio: number; badgeCornerClear: boolean; smallFontPx: number; warnings: string[] }

const KEY = (id: string) => `vp:thumb:${id}`;

export function ThumbsPanel({ project, actions }: { project: ProjectView; actions: Actions }) {
  const outputs = useOutputs(project.id);
  const thumbs = (outputs.data ?? []).filter((o) => o.type === "thumbnail").sort((a, b) => String(a.kind).localeCompare(String(b.kind)));
  const [picked, setPicked] = useState<string | null>(null);

  // remembered per viewer only; the app works without it
  useEffect(() => {
    try {
      setPicked(localStorage.getItem(KEY(project.id)));
    } catch {
      /* storage blocked */
    }
  }, [project.id]);
  const pick = (v: string) => {
    setPicked(v);
    try {
      localStorage.setItem(KEY(project.id), v);
    } catch {
      /* ignore */
    }
  };

  const afterFinal = ["final_rendered", "thumbnails_ready", "metadata_ready", "done"].includes(project.status);

  return (
    <Card
      title="Thumbnails"
      actions={<Button variant="ghost" busy={actions.thumbnails.isPending} disabled={!project.styleAnchorAssetId} onClick={() => actions.thumbnails.mutate()}>{thumbs.length ? "Regenerate all 3" : "Generate 3 thumbnails"}</Button>}
    >
      <ErrorText error={actions.thumbnails.error} />
      {thumbs.length === 0 && <Empty>{afterFinal ? (project.activeJobs > 0 ? "Generating thumbnails…" : "No thumbnails yet.") : "Thumbnails are generated automatically after the final render."}</Empty>}
      <div className="space-y-6">
        {thumbs.map((t) => {
          const check = (t.params?.check ?? null) as Check | null;
          const variant = String(t.kind);
          return (
            <div key={t.id} className={`rounded-lg border-2 p-3 ${picked === variant ? "border-[var(--accent)]" : "border-[var(--line)]"}`}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <strong>Variant {variant}</strong>
                <span className="text-sm text-[var(--muted)]">“{String(t.params?.text ?? "")}”</span>
                {check && <Badge tone={check.warnings.length ? "warn" : "ok"}>contrast {check.contrast.toFixed(1)}:1 · text {(check.textWidthRatio * 100).toFixed(0)}% wide</Badge>}
                {check?.warnings.map((w, i) => <Badge key={i} tone="warn">{w}</Badge>)}
                <div className="ml-auto flex gap-2">
                  <Button variant={picked === variant ? "primary" : "ghost"} onClick={() => pick(variant)}>{picked === variant ? "Chosen" : "Use this one"}</Button>
                  <a className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-[var(--hover)]" href={`/api${t.url}?download=1`}>Download</a>
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-4">
                <img src={`/api${t.url}`} alt={`Thumbnail ${variant} at full size`} className="w-full max-w-3xl rounded" />
                <figure>
                  <img src={`/api${t.url}`} alt={`Thumbnail ${variant} at 168 by 94`} width={168} height={94} className="rounded" style={{ width: 168, height: 94 }} />
                  <figcaption className="mt-1 text-xs text-[var(--muted)]">As small as YouTube’s sidebar (168×94)</figcaption>
                </figure>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
