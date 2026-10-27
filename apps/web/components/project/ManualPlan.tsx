"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { Badge, Button, ErrorText } from "@/components/ui";
import type { Actions } from "./actions";

/**
 * Plan without an Anthropic API key: copy the prompt, run it in Claude desktop (or claude.ai),
 * paste the JSON back. The same checks as the API planner apply, including the word-for-word narration check.
 */
export function ManualPlan({ projectId, actions, defaultOpen }: { projectId: string; actions: Actions; defaultOpen: boolean }) {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function getPrompt(): Promise<string> {
    return (await api.get<{ prompt: string }>(`/projects/${projectId}/plan/prompt`)).prompt;
  }

  async function copy() {
    setLoading(true);
    setErr(null);
    try {
      const prompt = await getPrompt();
      try {
        await navigator.clipboard.writeText(prompt);
        setCopied("ok");
      } catch {
        setCopied("fail"); // clipboard blocked: offer the download instead
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function download() {
    try {
      const blob = new Blob([await getPrompt()], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "plan-prompt.txt";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function onFile(f: File | undefined) {
    if (f) setText(await f.text());
  }

  return (
    <details open={defaultOpen} className="mb-4 rounded border border-[var(--line)] bg-[var(--hover)]/40 p-3">
      <summary className="cursor-pointer text-sm font-medium">Plan with Claude desktop instead of the API (no API credit needed)</summary>
      <ol className="mt-3 list-decimal space-y-3 pl-5 text-sm">
        <li>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" busy={loading} onClick={copy}>Copy prompt</Button>
            <Button variant="ghost" onClick={download}>Download as .txt</Button>
            {copied === "ok" && <Badge tone="ok">Copied</Badge>}
            {copied === "fail" && <Badge tone="warn">Clipboard blocked: use Download</Badge>}
          </div>
          <p className="mt-1 text-xs text-[var(--muted)]">It contains the planning rules and your script. Paste it into a new Claude chat.</p>
        </li>
        <li>
          Claude answers with JSON. If the reply is long, ask it to put the JSON in a file or artifact, then copy that.
        </li>
        <li>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder='Paste the JSON here: {"scenes": [ ... ]}'
            className="h-40 w-full font-mono text-xs"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button busy={actions.importPlan.isPending} disabled={!text.trim()} onClick={() => actions.importPlan.mutate(text, { onSuccess: () => setText("") })}>Import plan</Button>
            <label className="cursor-pointer rounded-md border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-[var(--hover)]">
              Load a .json / .txt file
              <input type="file" accept=".json,.txt,application/json,text/plain" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            {actions.importPlan.isSuccess && <Badge tone="ok">Imported {actions.importPlan.data?.scenes} scenes</Badge>}
          </div>
          <ErrorText error={actions.importPlan.error} />
          {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
          <p className="mt-1 text-xs text-[var(--muted)]">
            If the import says the narration differs from your script, copy that message back to Claude and ask it to fix the scenes.
            Your words are never changed by the app.
          </p>
        </li>
      </ol>
    </details>
  );
}
