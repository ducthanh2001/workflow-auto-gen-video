"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { api, type ProjectView, type ScriptPreview } from "@/lib/api";
import { Badge, Button, Card, ErrorText } from "@/components/ui";

const EXAMPLE = `---
title: What Happens in the First 24 Hours After You Die?
language: en
voice: narrator_calm
style: stickman-hero
target_minutes: 10
sources:
  - https://example.org/paper-1
---

## Hook
Paste your narration here. Each "##" heading starts a beat, becomes a YouTube chapter, and is never read aloud.

## Next beat
Everything else is narration, in order. It is never rewritten, reordered, added to or dropped.
`;

export default function NewProjectPage() {
  const router = useRouter();
  const [script, setScript] = useState("");
  const [preview, setPreview] = useState<ScriptPreview | null>(null);

  // live parse result (debounced) from the same parser the server uses
  useEffect(() => {
    if (!script.trim()) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      api.post<ScriptPreview>("/projects/preview", { script }).then(setPreview).catch((e) => setPreview({ ok: false, error: (e as Error).message }));
    }, 400);
    return () => clearTimeout(t);
  }, [script]);

  const create = useMutation({
    mutationFn: () => api.post<ProjectView>("/projects", { script }),
    onSuccess: (p) => router.push(`/projects/${p.id}`),
  });

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (!/\.(md|txt)$/i.test(f.name)) return alert("Only .md or .txt files are accepted.");
    if (f.size > 200 * 1024) return alert("The script file is larger than 200 KB.");
    setScript(await f.text());
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <Card
        title="New project from a script"
        actions={
          <>
            <label className="cursor-pointer rounded-md border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-[var(--hover)]">
              Upload .md / .txt
              <input type="file" accept=".md,.txt,text/markdown,text/plain" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            <Button variant="ghost" onClick={() => setScript(EXAMPLE)}>Insert template</Button>
          </>
        }
      >
        <textarea
          value={script}
          onChange={(e) => setScript(e.target.value)}
          spellCheck={false}
          placeholder="Paste your English script (front matter + ## beats)…"
          className="h-[28rem] w-full resize-y font-mono text-[13px] leading-relaxed"
        />
        <div className="mt-3 flex items-center gap-3">
          <Button busy={create.isPending} disabled={!preview?.ok} onClick={() => create.mutate()}>Create project</Button>
          <span className="text-xs text-[var(--muted)]">Nothing is generated or paid for yet; you review every step.</span>
        </div>
        <ErrorText error={create.error} />
      </Card>

      <Card title="Parse result">
        {!preview && <p className="text-sm text-[var(--muted)]">Paste a script to see its beats, word count and warnings.</p>}
        {preview && !preview.ok && <p className="text-sm text-red-600">{preview.error}</p>}
        {preview?.ok && (
          <div className="space-y-3 text-sm">
            <div>
              <div className="font-medium">{preview.title}</div>
              <div className="text-[var(--muted)]">
                {preview.wordCount} words · about {preview.estimatedMinutes} min · voice <code>{preview.voice}</code> · style <code>{preview.style}</code>
              </div>
              {(!preview.voiceKnown || !preview.styleKnown) && (
                <p className="mt-1 text-red-600">
                  {!preview.voiceKnown && "Unknown voice key. "}
                  {!preview.styleKnown && "Unknown style key."}
                </p>
              )}
            </div>
            <ul className="divide-y divide-[var(--line)] rounded border border-[var(--line)]">
              {preview.beats?.map((b, i) => (
                <li key={i} className="flex items-center justify-between px-2 py-1.5">
                  <span>{i + 1}. {b.title}</span>
                  <span className="text-xs text-[var(--muted)]">{b.words} words</span>
                </li>
              ))}
            </ul>
            {preview.warnings?.map((w, i) => (
              <div key={i}><Badge tone="warn">warning</Badge> <span className="ml-1">{w}</span></div>
            ))}
            {!preview.warnings?.length && <Badge tone="ok">No warnings</Badge>}
          </div>
        )}
      </Card>
    </div>
  );
}
