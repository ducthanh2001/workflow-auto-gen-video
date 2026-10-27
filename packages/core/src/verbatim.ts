/** Verbatim check (spec 6.2): the plan must contain exactly the script's words. */

/** lowercase, strip everything except letters and digits */
export function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export interface VerbatimResult {
  ok: boolean;
  /** human-readable description of the first divergence (for the retry prompt) */
  diff?: string;
}

export function verbatimCheck(scriptNarration: string, sceneNarrations: string[]): VerbatimResult {
  const a = normalizeForCompare(scriptNarration);
  const b = normalizeForCompare(sceneNarrations.join(" "));
  if (a === b) return { ok: true };

  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i++;

  // Locate the scene where the mismatch begins.
  let offset = 0;
  let sceneIdx = sceneNarrations.length - 1;
  for (let k = 0; k < sceneNarrations.length; k++) {
    const len = normalizeForCompare(sceneNarrations[k]).length;
    if (i < offset + len) {
      sceneIdx = k;
      break;
    }
    offset += len;
  }
  const ctx = (s: string) => s.slice(Math.max(0, i - 25), i + 40);
  const diff =
    `First difference near scene ${sceneIdx + 1}. ` +
    `Script has "...${ctx(a)}..." but the scenes have "...${ctx(b)}...". ` +
    `Script length ${a.length} vs scenes length ${b.length} (letters and digits only).`;
  return { ok: false, diff };
}
