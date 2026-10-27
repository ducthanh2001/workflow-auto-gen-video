export const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

export function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export const STATE_LABEL: Record<string, string> = {
  created: "Created", parsed: "Parsed", planned: "Plan ready", plan_approved: "Plan approved", refs_ready: "References ready",
  refs_approved: "References approved", voiced: "Voiced", imaged: "Images ready", images_approved: "Images approved",
  motion_done: "Motion done", draft_rendered: "Draft ready", draft_approved: "Draft approved", final_rendered: "Final rendered",
  thumbnails_ready: "Thumbnails ready", metadata_ready: "Metadata ready", done: "Done",
};

export const GATE_LABEL: Record<string, string> = {
  plan_approved: "plan", refs_approved: "references", images_approved: "images", draft_approved: "draft",
};
