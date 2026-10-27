"use client";
import { useQuery } from "@tanstack/react-query";
import type { ProjectView } from "@/lib/api";
import { useOutputs } from "@/lib/hooks";
import { bytes } from "@/lib/format";
import { Badge, Button, Card, Empty, ErrorText } from "@/components/ui";
import type { Actions } from "./actions";

const LABEL: Record<string, string> = {
  "final.mp4": "Final video (1920×1080)",
  "captions.en.srt": "Captions (SRT)",
  "captions.ass": "Captions (styled ASS, used for the burn-in)",
  "metadata.md": "YouTube metadata",
  "report.json": "Run report (cost, retries, A/V drift)",
};

export function FinalPanel({ project, actions }: { project: ProjectView; actions: Actions }) {
  const outputs = useOutputs(project.id);
  const list = (outputs.data ?? []).filter((o) => o.type !== "thumbnail" && !(o.type === "video" && o.kind === "draft"));
  const final = list.find((o) => o.type === "video" && o.kind === "final");
  const hasDraft = (outputs.data ?? []).some((o) => o.type === "video" && o.kind === "draft");
  const meta = list.find((o) => o.type === "doc" && o.kind === "metadata");
  const stale = project.stale.includes("final");

  const md = useQuery({
    queryKey: ["metadata-text", meta?.id],
    queryFn: async () => (await fetch(`/api${meta!.url}`)).text(),
    enabled: !!meta,
  });

  return (
    <div className="space-y-4">
      <Card
        title={<span className="flex items-center gap-2">Final and downloads {final && (stale ? <Badge tone="warn">out of date</Badge> : <Badge tone="ok">up to date</Badge>)}</span>}
        actions={
          <>
            <Button variant="ghost" busy={actions.render.isPending} disabled={!hasDraft} title={hasDraft ? undefined : "Render and approve a draft first"} onClick={() => actions.render.mutate("final")}>
              {final ? "Render final again" : "Render final"}
            </Button>
            <Button variant="ghost" busy={actions.metadata.isPending} disabled={!final} onClick={() => actions.metadata.mutate()}>Regenerate metadata</Button>
          </>
        }
      >
        <ErrorText error={actions.render.error ?? actions.metadata.error} />
        {list.length === 0 && <Empty>Nothing here yet. The final render starts after you approve the draft.</Empty>}
        <ul className="divide-y divide-[var(--line)]">
          {list.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div>
                <div className="font-medium">{LABEL[o.name] ?? o.name}</div>
                <div className="text-xs text-[var(--muted)]">{o.name} · {bytes(o.bytes)}</div>
              </div>
              <div className="flex items-center gap-2">
                {o.stale && <Badge tone="warn">stale</Badge>}
                <a className="rounded-md border border-[var(--line)] px-3 py-1.5 hover:bg-[var(--hover)]" href={`/api${o.url}?download=1`}>Download</a>
              </div>
            </li>
          ))}
        </ul>
        {final && (
          <video src={`/api${final.url}`} controls preload="metadata" className="mt-4 aspect-video w-full max-w-4xl rounded bg-black" />
        )}
      </Card>

      {meta && (
        <Card title="metadata.md" actions={<Button variant="ghost" onClick={() => md.data && navigator.clipboard?.writeText(md.data)}>Copy</Button>}>
          <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap text-sm">{md.data ?? "Loading…"}</pre>
        </Card>
      )}
    </div>
  );
}
