import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { apiPost, ApiError } from "@/lib/api";

const TYPES = [
  { id: "flashcards", label: "Flashcards", desc: "Front/back cards. Tap to flip." },
  { id: "quiz", label: "Quiz", desc: "Multiple-choice questions with score." },
  { id: "reading", label: "Reading", desc: "Short text snippets, scrollable." },
  { id: "counter", label: "Counter", desc: "Tally / habit / repetition counter." },
  { id: "timer", label: "Timer", desc: "Countdown / interval timer." },
];

const CATEGORIES = ["languages", "math", "science", "history", "wellness", "fun", "podcasts", "other"];

const TEMPLATES: Record<string, object> = {
  flashcards: {
    cards: [
      { front: "Hello", back: "Habari" },
      { front: "Thank you", back: "Asante" },
    ],
  },
  quiz: {
    questions: [
      { q: "2 + 2 = ?", choices: ["3", "4", "5"], correct: 1 },
    ],
  },
  reading: {
    pages: [{ title: "Intro", body: "Welcome to my mini-app." }],
  },
  counter: { label: "Push-ups", target: 50 },
  timer: { duration_seconds: 60, label: "Focus" },
};

export default function NewAppPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const [step, setStep] = useState(1);
  const [type, setType] = useState("flashcards");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [icon, setIcon] = useState("📚");
  const [category, setCategory] = useState("languages");
  const [description, setDescription] = useState("");
  const [priceMode, setPriceMode] = useState<"free" | "kp" | "tsh">("free");
  const [priceKp, setPriceKp] = useState(0);
  const [priceTsh, setPriceTsh] = useState(0);
  const [manifestText, setManifestText] = useState(
    JSON.stringify(TEMPLATES.flashcards, null, 2),
  );
  const [submitNow, setSubmitNow] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canNext = useMemo(() => {
    if (step === 1) return !!type;
    if (step === 2) return name.trim().length > 1 && /^[a-z0-9-]+$/.test(slug);
    if (step === 3) {
      try {
        JSON.parse(manifestText);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }, [step, type, name, slug, manifestText]);

  function pickType(t: string) {
    setType(t);
    setManifestText(JSON.stringify(TEMPLATES[t], null, 2));
  }

  function autoSlug(v: string) {
    setName(v);
    if (!slug || slug === slugify(name)) {
      setSlug(slugify(v));
    }
  }

  async function submit() {
    setErr(null);
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      setErr("Manifest must be valid JSON.");
      return;
    }
    setBusy(true);
    try {
      const created = await apiPost<{ app: { id: number } }>("/v1/dev/apps", {
        slug,
        name,
        description: description || undefined,
        icon,
        category,
        type,
        price_kp: priceMode === "kp" ? priceKp : 0,
        price_tsh: priceMode === "tsh" ? priceTsh : 0,
        manifest,
      });
      if (submitNow) {
        await apiPost(`/v1/dev/apps/${created.app.id}/submit`, {});
      }
      qc.invalidateQueries({ queryKey: ["dev-apps"] });
      setLocation("/dashboard");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed to create app");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <button onClick={() => setLocation("/dashboard")} className="text-sm text-gray-600 mb-4">
        ← Back to dashboard
      </button>
      <h1 className="text-2xl font-bold mb-1">New mini-app</h1>
      <p className="text-sm text-gray-600 mb-6">
        Step {step} of 4 — {["Type", "Details", "Manifest", "Pricing & submit"][step - 1]}
      </p>

      <div className="card">
        {step === 1 && (
          <div className="space-y-3">
            {TYPES.map((t) => (
              <button
                key={t.id}
                onClick={() => pickType(t.id)}
                className="w-full text-left p-4 rounded-lg border-2 transition"
                style={{
                  borderColor: type === t.id ? "#00A86B" : "#e2e2e2",
                  background: type === t.id ? "#f0faf6" : "white",
                }}
              >
                <div className="font-semibold">{t.label}</div>
                <div className="text-sm text-gray-600">{t.desc}</div>
              </button>
            ))}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <label className="label">Name</label>
              <input
                className="input"
                value={name}
                onChange={(e) => autoSlug(e.target.value)}
                placeholder="Swahili Greetings"
              />
            </div>
            <div>
              <label className="label">Slug</label>
              <input
                className="input"
                value={slug}
                onChange={(e) => setSlug(slugify(e.target.value))}
                placeholder="swahili-greetings"
              />
              <p className="text-xs text-gray-500 mt-1">
                Lowercase letters, numbers, dashes only.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Icon (emoji)</label>
                <input
                  className="input"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  maxLength={4}
                />
              </div>
              <div>
                <label className="label">Category</label>
                <select
                  className="input"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="label">Description</label>
              <textarea
                className="input"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does your mini-app do?"
              />
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <label className="label">Manifest (JSON)</label>
            <textarea
              className="input font-mono text-xs"
              rows={16}
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              spellCheck={false}
            />
            <p className="text-xs text-gray-500 mt-2">
              The runtime on the watch reads this manifest and renders the experience.
              We pre-filled a template for <code>{type}</code> — edit to taste.
            </p>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <div>
              <label className="label">Pricing</label>
              <div className="flex gap-2">
                {(["free", "kp", "tsh"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setPriceMode(m)}
                    className="px-4 py-2 rounded-lg border-2"
                    style={{
                      borderColor: priceMode === m ? "#00A86B" : "#e2e2e2",
                      background: priceMode === m ? "#f0faf6" : "white",
                      fontWeight: 600,
                      flex: 1,
                    }}
                  >
                    {m === "free" ? "Free" : m === "kp" ? "Pay with KP" : "Pay with TSh"}
                  </button>
                ))}
              </div>
            </div>
            {priceMode === "kp" && (
              <div>
                <label className="label">Price (KP)</label>
                <input
                  type="number"
                  className="input"
                  min={0}
                  value={priceKp}
                  onChange={(e) => setPriceKp(Number(e.target.value) || 0)}
                />
                <p className="text-xs text-gray-500 mt-1">You earn 70% — {Math.floor(priceKp * 0.7)} KP per purchase.</p>
              </div>
            )}
            {priceMode === "tsh" && (
              <div>
                <label className="label">Price (TSh)</label>
                <input
                  type="number"
                  className="input"
                  min={0}
                  value={priceTsh}
                  onChange={(e) => setPriceTsh(Number(e.target.value) || 0)}
                />
                <p className="text-xs text-gray-500 mt-1">
                  You earn 70% — TSh {Math.floor(priceTsh * 0.7).toLocaleString()} per purchase.
                </p>
              </div>
            )}
            <label className="flex items-center gap-2 mt-3">
              <input
                type="checkbox"
                checked={submitNow}
                onChange={(e) => setSubmitNow(e.target.checked)}
              />
              <span className="text-sm">Submit for moderation immediately</span>
            </label>
            {err && <p className="text-sm text-red-600">{err}</p>}
          </div>
        )}

        <div className="flex justify-between mt-6">
          <button
            className="btn-ghost"
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1}
          >
            Back
          </button>
          {step < 4 ? (
            <button
              className="btn-primary"
              onClick={() => setStep((s) => s + 1)}
              disabled={!canNext}
            >
              Next
            </button>
          ) : (
            <button className="btn-primary" onClick={submit} disabled={busy}>
              {busy ? "Creating…" : submitNow ? "Create & submit" : "Save as draft"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
