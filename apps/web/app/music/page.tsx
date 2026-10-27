"use client";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MusicTrack } from "@/lib/api";
import { mmss } from "@/lib/format";
import { Button, Card, Empty, ErrorText } from "@/components/ui";

export default function MusicPage() {
  const qc = useQueryClient();
  const tracks = useQuery({ queryKey: ["music"], queryFn: () => api.get<MusicTrack[]>("/music") });
  const form = useRef<HTMLFormElement>(null);
  const [license, setLicense] = useState("");

  const upload = useMutation({
    mutationFn: (fd: FormData) => api.upload("/music", fd),
    onSuccess: () => {
      form.current?.reset();
      setLicense("");
      void qc.invalidateQueries({ queryKey: ["music"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/music/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["music"] }),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
      <Card title="Music library">
        {tracks.data?.length === 0 && <Empty>No tracks yet. Upload a track you have the rights to use.</Empty>}
        <ul className="divide-y divide-[var(--line)]">
          {tracks.data?.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <div className="font-medium">{t.name}</div>
                <div className="text-xs text-[var(--muted)]">{mmss(t.durationSec)} · added {new Date(t.createdAt).toLocaleDateString()}</div>
                <div className="mt-1 text-sm"><span className="text-[var(--muted)]">License:</span> {t.licenseNote}</div>
              </div>
              <Button variant="danger" busy={remove.isPending && remove.variables === t.id} onClick={() => confirm(`Delete “${t.name}”?`) && remove.mutate(t.id)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Add a track">
        <form
          ref={form}
          className="space-y-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            upload.mutate(new FormData(e.currentTarget));
          }}
        >
          <label className="block">
            <span className="mb-1 block text-[var(--muted)]">Audio file (.mp3 or .wav, up to 50 MB)</span>
            <input name="file" type="file" accept=".mp3,.wav,audio/mpeg,audio/wav" required className="w-full" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--muted)]">Name</span>
            <input name="name" className="w-full" placeholder="Optional" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[var(--muted)]">License note (required)</span>
            <textarea
              name="licenseNote"
              required
              value={license}
              onChange={(e) => setLicense(e.target.value)}
              className="h-24 w-full"
              placeholder="Where it came from and what the license allows, e.g. “Purchased from … on 2026-03-02, standard commercial license, order #1234”"
            />
          </label>
          <p className="text-xs text-[var(--muted)]">The app never downloads or generates music. A track without a license note cannot be saved or used.</p>
          <Button type="submit" busy={upload.isPending} disabled={!license.trim()}>Upload</Button>
          <ErrorText error={upload.error} />
        </form>
      </Card>
    </div>
  );
}
