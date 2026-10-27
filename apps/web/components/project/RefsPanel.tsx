"use client";
/* eslint-disable @next/next/no-img-element */
import { PROJECT_STATES } from "@vp/shared";
import type { ProjectView } from "@/lib/api";
import { useGlobalHero, useRefs } from "@/lib/hooks";
import { Badge, Button, Card, Empty, ErrorText } from "@/components/ui";
import type { Actions } from "./actions";

export function RefsPanel({ project, actions }: { project: ProjectView; actions: Actions }) {
  const refs = useRefs(project.id);
  const globalHero = useGlobalHero();
  const i = (s: string) => PROJECT_STATES.indexOf(s as never);
  const unlocked = i(project.status) >= i("plan_approved");
  const sheet = refs.data?.characterSheets.find((s) => s.selected) ?? refs.data?.characterSheets[0];
  const hasRefs = !!sheet;

  return (
    <Card
      title="References: character sheet and style anchor"
      actions={
        <>
          <label className={`cursor-pointer rounded-md border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-[var(--hover)] ${!unlocked ? "pointer-events-none opacity-50" : ""}`}>
            Upload my own character sheet
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && actions.uploadSheet.mutate(e.target.files[0])} />
          </label>
          <Button variant="ghost" disabled={!unlocked} busy={actions.refs.isPending} onClick={() => actions.refs.mutate()}>{hasRefs ? "Regenerate" : "Generate"}</Button>
          {project.awaitingGate === "refs_approved" && (
            <Button
              disabled={!project.styleAnchorAssetId}
              busy={actions.approve.isPending}
              onClick={() => actions.approve.mutate("refs_approved")}
              title={project.styleAnchorAssetId ? undefined : "Pick a style anchor first"}
            >
              Approve references & continue
            </Button>
          )}
        </>
      }
    >
      <ErrorText error={actions.refs.error ?? actions.selectRefs.error ?? actions.uploadSheet.error ?? actions.approve.error ?? actions.saveGlobal.error ?? actions.modernSheet.error ?? actions.uploadGlobal.error ?? actions.useGlobal.error} />
      {unlocked && (
        <p className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <b>The hero is shared by all videos.</b> New projects copy the global hero sheet ({globalHero.data?.sheet ? "saved" : "none saved yet"}).
          “Regenerate” and “Upload my own character sheet” change the hero <b>for this project only</b>; use “Save as the global hero” to change it for every project.
        </p>
      )}
      {!unlocked && <Empty>Approve the plan first. References are generated once per project and used for every image.</Empty>}
      {unlocked && !hasRefs && <Empty>{project.activeJobs > 0 ? "Generating references…" : "No references yet. Press Generate (about 5 images)."}</Empty>}
      {hasRefs && (
        <div className="space-y-5">
          <div>
            <h3 className="mb-2 text-sm font-medium">Character sheet {sheet.uploaded && <Badge tone="info">your own</Badge>}</h3>
            <img src={`/api${sheet.url}`} alt="Character sheet" className="max-h-72 rounded border border-[var(--line)]" />
            <p className="mt-1 text-xs text-[var(--muted)]">
              Used as a reference for every scene so the characters stay consistent. Use your own original characters; do not imitate another channel’s.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {sheet.global && <Badge tone="ok">global hero</Badge>}
              {refs.data?.lockVersion != null && <Badge title="Character lock version these references were made with">lock v{refs.data.lockVersion}</Badge>}
              {!sheet.global && globalHero.data?.sheet && (
                <Button variant="ghost" className="px-2 py-1 text-xs" busy={actions.useGlobal.isPending} onClick={() => actions.useGlobal.mutate()} title="Use the saved global hero sheet in this project (free, nothing is drawn)">
                  Use the global hero here
                </Button>
              )}
              {!sheet.global && (
                <Button variant="ghost" className="px-2 py-1 text-xs" busy={actions.saveGlobal.isPending} onClick={() => actions.saveGlobal.mutate({ kind: "sheet" })}>
                  Save as the global hero
                </Button>
              )}
              <label className="cursor-pointer rounded-md border border-[var(--line)] px-2 py-1 text-xs hover:bg-[var(--hover)]" title="Upload the approved hero sheet (for example made in Gemini chat with the reference frame). It becomes the hero of every project.">
                Upload the global hero sheet
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) actions.uploadGlobal.mutate({ kind: "sheet", file: f }); }} />
              </label>
              <label className="cursor-pointer rounded-md border border-[var(--line)] px-2 py-1 text-xs hover:bg-[var(--hover)]" title="A clean frame of your hero from a published video. Used as the look reference when a new hero sheet is drawn.">
                {globalHero.data?.reference ? "Replace hero reference frame" : "Upload hero reference frame"}
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) actions.uploadGlobal.mutate({ kind: "reference", file: f }); }} />
              </label>
            </div>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">Modern-outfit sheet <span className="text-xs font-normal text-[var(--muted)]">(used when the hero wears a shirt, hoodie, jacket or suit)</span></h3>
            {(refs.data?.modernSheets ?? []).map((m) => (
              <div key={m.id} className="mb-2">
                <img src={`/api${m.url}`} alt="Modern-outfit hero sheet" className="max-h-60 rounded border border-[var(--line)]" />
                <div className="mt-1 flex items-center gap-2">
                  {m.global && <Badge tone="ok">global</Badge>}
                  {m.draft && <Badge tone="warn">draft</Badge>}
                  {m.draft && (
                    <Button variant="ghost" className="px-2 py-1 text-xs" busy={actions.saveGlobal.isPending} onClick={() => actions.saveGlobal.mutate({ kind: "modern", assetId: m.id })}>
                      Save as the global modern sheet
                    </Button>
                  )}
                </div>
              </div>
            ))}
            <label className="mr-2 inline-flex cursor-pointer items-center rounded-md border border-[var(--line)] px-2 py-1 text-xs hover:bg-[var(--hover)]">
              Upload the global modern sheet
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) actions.uploadGlobal.mutate({ kind: "modern", file: f }); }} />
            </label>
            <Button variant="ghost" className="px-2 py-1 text-xs" busy={actions.modernSheet.isPending} onClick={() => actions.modernSheet.mutate()}>
              {refs.data?.modernSheets.length ? "Draw another modern sheet" : "Generate the modern sheet"} (1 image)
            </Button>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">Style sample <span className="text-xs font-normal text-[var(--muted)]">(every picture copies its painting style; with APIZ it is also the picture that carries the hero)</span></h3>
            <p className="mb-2 text-xs text-[var(--muted)]">
              {globalHero.data?.anchor
                ? "A global style sample is saved: new projects use it and nothing is drawn for this step."
                : "No global style sample saved yet: upload one (a finished scene with your hero in it) and every project will use it."}
            </p>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label className="cursor-pointer rounded-md border border-[var(--line)] px-2 py-1 text-xs hover:bg-[var(--hover)]" title="Upload the approved style sample. It becomes the style of every project.">
                Upload the global style sample
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) actions.uploadGlobal.mutate({ kind: "anchor", file: f }); }} />
              </label>
              {project.styleAnchorAssetId && !refs.data!.anchors.find((a) => a.selected)?.global && (
                <Button variant="ghost" className="px-2 py-1 text-xs" busy={actions.saveGlobal.isPending} onClick={() => actions.saveGlobal.mutate({ kind: "anchor" })}>
                  Save the selected one as the global style sample
                </Button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {refs.data!.anchors.map((a) => (
                <button
                  key={a.id}
                  onClick={() => actions.selectRefs.mutate({ anchorAssetId: a.id, characterSheetAssetId: sheet.id })}
                  className={`overflow-hidden rounded-lg border-2 text-left transition ${a.selected ? "border-[var(--accent)]" : "border-transparent hover:border-[var(--line)]"}`}
                  aria-pressed={a.selected}
                >
                  <img src={`/api${a.url}`} alt="Style anchor candidate" className="aspect-video w-full object-cover" />
                  <div className="flex items-center gap-1 p-1.5 text-xs">{a.selected ? <Badge tone="ok">selected</Badge> : "Choose"}{a.global && <Badge tone="info">global</Badge>}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
