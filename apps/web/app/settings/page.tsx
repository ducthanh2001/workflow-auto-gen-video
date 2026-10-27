"use client";
import { useQuery } from "@tanstack/react-query";
import { api, type DepsReport } from "@/lib/api";
import { Badge, Card, ErrorText } from "@/components/ui";

const row = "flex items-center justify-between gap-4 border-t border-[var(--line)] py-2 text-sm first:border-t-0";

export default function SettingsPage() {
  const { data, error, isLoading } = useQuery({ queryKey: ["deps"], queryFn: () => api.get<DepsReport>("/health/deps"), refetchInterval: 15000 });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Dependencies">
        {isLoading && <p className="text-sm text-[var(--muted)]">Checking…</p>}
        <ErrorText error={error} />
        {data && (
          <div>
            <div className={row}>
              <span>ffmpeg {data.ffmpeg.version && <code className="text-xs text-[var(--muted)]">{data.ffmpeg.version}</code>}</span>
              <Badge tone={data.ffmpeg.ok ? "ok" : "bad"}>{data.ffmpeg.ok ? "ok" : (data.ffmpeg.error ?? `missing ${data.ffmpeg.missing.join(", ")}`)}</Badge>
            </div>
            <div className={row}>
              <span>Fonts</span>
              <Badge tone={data.fonts.ok ? "ok" : "bad"}>{data.fonts.ok ? "ok" : `missing ${data.fonts.missing.join(", ")}`}</Badge>
            </div>
            <div className={row}>
              <span>PostgreSQL</span>
              <Badge tone={data.db.ok ? "ok" : "bad"}>{data.db.ok ? "ok" : (data.db.error ?? "down")}</Badge>
            </div>
            <div className={row}>
              <span>Redis</span>
              <Badge tone={data.redis.ok ? "ok" : "bad"}>{data.redis.ok ? "ok" : (data.redis.error ?? "down")}</Badge>
            </div>
          </div>
        )}
      </Card>

      <Card title="Providers">
        {data && (
          <div>
            {data.mockProviders && <p className="mb-2 rounded bg-amber-500/15 p-2 text-sm">Mock providers are on (<code>PROVIDERS=mock</code>): no real service is called.</p>}
            {Object.entries(data.keys).map(([k, v]) => (
              <div key={k} className={row}>
                <code>{k}</code>
                <Badge tone={v === "configured" ? "ok" : "warn"}>{v}</Badge>
              </div>
            ))}
            <p className="mt-3 text-xs text-[var(--muted)]">
              Keys live only in the server environment (<code>.env</code>); the browser never sees them, so there is nothing to enter here.
              Voices are chosen in <code>config/voices.json</code>.
            </p>
          </div>
        )}
      </Card>

      {data && data.warnings.length > 0 && (
        <Card title="Warnings" className="lg:col-span-2">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}
