/** Content filter applied before any image prompt (spec 16.1, 16.2). */

const BLOCKED: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(gore|gory|blood(y|shed)?|mutilat\w*|dismember\w*|decapitat\w*|entrails|viscera)\b/i, reason: "graphic injury" },
  { re: /\b(corpse|cadaver|dead bod(y|ies)|mortuary slab|autopsy table)\b/i, reason: "graphic body" },
  { re: /\b(suicid\w*|self[- ]harm|hanging noose|noose|overdose|slit(ting)? wrists?|jump(ing)? off)\b/i, reason: "self-harm or methods of death" },
  { re: /\b(logo|trademark|watermark|brand name)\b/i, reason: "logo/brand" },
  { re: /\b(mickey mouse|spider-?man|pikachu|mario|batman|superman|hello kitty)\b/i, reason: "copyrighted character" },
];

export interface SafetyResult {
  ok: boolean;
  reasons: string[];
}

export function checkVisualPrompt(visual: string): SafetyResult {
  const reasons = BLOCKED.filter((b) => b.re.test(visual)).map((b) => b.reason);
  return { ok: reasons.length === 0, reasons };
}

/** Heuristic: capitalised two-word names look like real named people. */
export function mentionsNamedPerson(visual: string): boolean {
  return /\b(Dr|Mr|Mrs|Ms|President|King|Queen|Pope)\.?\s+[A-Z][a-z]+/.test(visual);
}

export function requireLicenseNote(note: string | null | undefined): string {
  const n = (note ?? "").trim();
  if (!n) throw new Error("A license note is required for every music track");
  return n;
}
