import { FormEvent, useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { apiGet, apiPost } from "@/lib/api";

interface Creative {
  id: number;
  format: string;
  title: string;
  body: string | null;
  image_url: string | null;
  cta_url: string;
  cta_label: string;
  width: number | null;
  height: number | null;
}

export default function Creatives() {
  const params = useParams();
  const id = params.id;
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["creatives", id],
    queryFn: () => apiGet<{ creatives: Creative[] }>(`/v1/advertiser/campaigns/${id}/creatives`),
    enabled: !!id,
  });

  const [format, setFormat] = useState("banner");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [ctaLabel, setCtaLabel] = useState("Learn more");
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      apiPost(`/v1/advertiser/campaigns/${id}/creatives`, {
        format,
        title,
        body: body || null,
        image_url: imageUrl || null,
        cta_url: ctaUrl,
        cta_label: ctaLabel,
        width: format === "banner" ? 320 : null,
        height: format === "banner" ? 100 : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["creatives", id] });
      setTitle("");
      setBody("");
      setImageUrl("");
      setCtaUrl("");
      setErr(null);
    },
    onError: (e: Error) => setErr(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <Layout>
      <div className="mb-4">
        <Link href="/dashboard" className="text-sm text-brand">
          ← Back to campaigns
        </Link>
      </div>
      <h1 className="text-2xl font-bold text-navy mb-1">Campaign #{id} creatives</h1>
      <p className="text-sm text-muted mb-6">Add one creative per format your placements allow.</p>

      <div className="grid lg:grid-cols-2 gap-6">
        <form onSubmit={onSubmit} className="card space-y-4">
          <h2 className="font-bold text-navy">Add creative</h2>
          <div>
            <label className="label">Format</label>
            <select className="input" value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="banner">banner</option>
              <option value="native">native</option>
              <option value="watch_tile">watch_tile</option>
              <option value="interstitial">interstitial</option>
            </select>
          </div>
          <div>
            <label className="label">Headline</label>
            <input className="input" required value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="label">Body (optional)</label>
            <textarea className="input" rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div>
            <label className="label">Image URL (optional)</label>
            <input className="input" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">CTA URL</label>
              <input className="input" required type="url" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="https://…" />
            </div>
            <div>
              <label className="label">CTA label</label>
              <input className="input" value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} />
            </div>
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <button className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? "Saving…" : "Add creative"}
          </button>
        </form>

        <div className="space-y-3">
          <h2 className="font-bold text-navy">Existing creatives</h2>
          {!data || data.creatives.length === 0 ? (
            <div className="card text-sm text-muted">No creatives yet.</div>
          ) : (
            data.creatives.map((c) => (
              <div key={c.id} className="card">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs uppercase font-bold text-brand">{c.format}</span>
                  <span className="text-xs text-muted">#{c.id}</span>
                </div>
                {c.image_url && (
                  <img
                    src={c.image_url}
                    alt=""
                    className="rounded mb-2 max-h-32 object-cover w-full"
                  />
                )}
                <div className="font-semibold text-navy">{c.title}</div>
                {c.body && <div className="text-sm text-muted">{c.body}</div>}
                <div className="mt-2 text-xs">
                  <span className="text-brand font-semibold">{c.cta_label}</span>{" "}
                  <span className="text-muted">→ {c.cta_url}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Layout>
  );
}
