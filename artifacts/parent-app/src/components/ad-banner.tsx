import { useEffect, useRef, useState } from "react";

interface AdResponse {
  ad: {
    impression_token: string;
    creative: {
      id: number;
      format: string;
      title: string;
      body: string | null;
      image_url: string | null;
      cta_url: string;
      cta_label: string;
    };
  } | null;
}

interface Props {
  placement: string;
  className?: string;
}

export function AdBanner({ placement, className = "" }: Props) {
  const [data, setData] = useState<AdResponse["ad"]>(null);
  const [hidden, setHidden] = useState(false);
  const trackedImpression = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/ads-api/v1/ads/serve?placement=${encodeURIComponent(placement)}`)
      .then((r) => r.json())
      .then((j: AdResponse) => {
        if (!cancelled) setData(j.ad);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [placement]);

  useEffect(() => {
    if (!data || trackedImpression.current) return;
    trackedImpression.current = true;
    fetch("/ads-api/v1/ads/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: data.impression_token, type: "impression" }),
    }).catch(() => {});
  }, [data]);

  if (!data || hidden) return null;

  const cre = data.creative;

  function onClick() {
    fetch("/ads-api/v1/ads/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: data!.impression_token, type: "click" }),
    }).catch(() => {});
    window.open(cre.cta_url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className={`relative rounded-xl overflow-hidden border border-gray-200 bg-white shadow-sm ${className}`}>
      <button
        onClick={() => setHidden(true)}
        aria-label="Hide ad"
        className="absolute top-1 right-1 z-10 w-6 h-6 rounded-full bg-black/30 text-white text-xs hover:bg-black/50"
      >
        ×
      </button>
      <button onClick={onClick} className="block w-full text-left">
        {cre.image_url && (
          <img src={cre.image_url} alt="" className="w-full h-24 object-cover" />
        )}
        <div className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wide">Sponsored</span>
          </div>
          <div className="font-bold text-sm text-gray-900 leading-tight">{cre.title}</div>
          {cre.body && <div className="text-xs text-gray-600 mt-1 line-clamp-2">{cre.body}</div>}
          <div className="mt-2 text-xs font-semibold text-[#00A86B]">{cre.cta_label} →</div>
        </div>
      </button>
    </div>
  );
}
