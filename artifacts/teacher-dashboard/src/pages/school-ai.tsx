import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { apiGet, apiPost } from "@/lib/api";
import { Cpu, Loader2, RefreshCcw, CheckCircle2, AlertTriangle, XCircle, Send } from "lucide-react";

type AiHealth = {
  configured_provider: string;
  configured_model: string;
  base_url: string;
  ollama_reachable: boolean;
  model_installed: boolean;
  installed_models: string[];
  latency_ms: number | null;
  error: string | null;
};

type AskResult = {
  answer: string;
  model: string;
  provider: string;
  latency_ms: number;
};

function StatusPill({ health }: { health: AiHealth }) {
  if (health.configured_provider !== "ollama") {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <AlertTriangle className="h-3.5 w-3.5" />
        Canned answers (no LLM configured)
      </Badge>
    );
  }
  if (!health.ollama_reachable) {
    return (
      <Badge variant="destructive" className="gap-1.5" data-testid="status-down">
        <XCircle className="h-3.5 w-3.5" />
        Ollama unreachable
      </Badge>
    );
  }
  if (!health.model_installed) {
    return (
      <Badge className="gap-1.5 bg-amber-500 hover:bg-amber-500/90" data-testid="status-model-missing">
        <AlertTriangle className="h-3.5 w-3.5" />
        Model not pulled
      </Badge>
    );
  }
  return (
    <Badge className="gap-1.5 bg-emerald-600 hover:bg-emerald-600/90" data-testid="status-ok">
      <CheckCircle2 className="h-3.5 w-3.5" />
      Online
    </Badge>
  );
}

export default function SchoolAi() {
  const [health, setHealth] = useState<AiHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState("Explain photosynthesis to a Form 1 student in two sentences.");
  const [system, setSystem] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);

  async function refreshHealth() {
    setHealthLoading(true);
    setHealthError(null);
    try {
      const h = await apiGet<AiHealth>("/v1/admin/ai/health");
      setHealth(h);
    } catch (e) {
      setHealthError(e instanceof Error ? e.message : String(e));
    } finally {
      setHealthLoading(false);
    }
  }

  useEffect(() => { void refreshHealth(); }, []);

  async function handleAsk() {
    if (!prompt.trim()) return;
    setAsking(true);
    setAnswer(null);
    setAnswerError(null);
    try {
      const r = await apiPost<AskResult>("/v1/admin/ai/test", {
        question: prompt,
        ...(system.trim() ? { system } : {}),
      });
      setAnswer(r);
    } catch (e) {
      setAnswerError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Cpu className="h-7 w-7 text-primary" />
            School AI
          </h1>
          <p className="text-muted-foreground mt-1">
            On-prem Ollama instance powering the watch tutor. Runs entirely offline on your school server.
          </p>
        </div>
        <Button variant="outline" onClick={refreshHealth} disabled={healthLoading} data-testid="btn-refresh">
          {healthLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCcw className="h-4 w-4 mr-2" />}
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Status</span>
            {health ? <StatusPill health={health} /> : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {healthLoading && !health ? (
            <div className="flex items-center text-muted-foreground"><Loader2 className="h-4 w-4 mr-2 animate-spin" />Probing Ollama…</div>
          ) : healthError ? (
            <div className="text-sm text-destructive">Couldn't reach the API: {healthError}</div>
          ) : health ? (
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm" data-testid="health-grid">
              <div><dt className="text-muted-foreground">Provider</dt><dd className="font-medium">{health.configured_provider}</dd></div>
              <div><dt className="text-muted-foreground">Configured model</dt><dd className="font-mono text-xs">{health.configured_model}</dd></div>
              <div className="sm:col-span-2"><dt className="text-muted-foreground">Ollama base URL</dt><dd className="font-mono text-xs break-all">{health.base_url}</dd></div>
              <div><dt className="text-muted-foreground">Latency</dt><dd>{health.latency_ms == null ? "—" : `${health.latency_ms} ms`}</dd></div>
              <div><dt className="text-muted-foreground">Models installed</dt><dd>{health.installed_models.length}</dd></div>
              {health.installed_models.length > 0 && (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground mb-1">Available models</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {health.installed_models.map((m) => (
                      <Badge key={m} variant="outline" className="font-mono text-xs">{m}</Badge>
                    ))}
                  </dd>
                </div>
              )}
              {health.error && (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Last error</dt>
                  <dd className="text-destructive font-mono text-xs">{health.error}</dd>
                </div>
              )}
            </dl>
          ) : null}

          {health && health.configured_provider === "ollama" && !health.ollama_reachable && (
            <div className="mt-4 p-3 rounded-md bg-amber-50 border border-amber-200 text-sm text-amber-900">
              <p className="font-medium mb-1">The on-prem LLM is offline.</p>
              <p>Students can still ask questions — the watch will silently fall back to a small canned answer set so the classroom keeps moving. Bring Ollama back up to restore full responses.</p>
              <p className="mt-2 font-mono text-xs">scripts/setup-ollama.sh</p>
            </div>
          )}
          {health && health.configured_provider === "ollama" && health.ollama_reachable && !health.model_installed && (
            <div className="mt-4 p-3 rounded-md bg-amber-50 border border-amber-200 text-sm text-amber-900">
              <p className="font-medium mb-1">Configured model "<span className="font-mono">{health.configured_model}</span>" isn't installed.</p>
              <p>SSH into the school server and run:</p>
              <pre className="mt-1 font-mono text-xs bg-amber-100 p-2 rounded">ollama pull {health.configured_model}</pre>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Test a prompt</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium">Question</label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              data-testid="prompt-input"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">System prompt (optional)</label>
            <Textarea
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              rows={2}
              placeholder="Leave blank to use the standard KobeAI tutor prompt."
              className="mt-1"
            />
          </div>
          <div className="flex items-center justify-end">
            <Button onClick={handleAsk} disabled={asking || !prompt.trim()} data-testid="btn-ask">
              {asking ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              {asking ? "Asking…" : "Ask"}
            </Button>
          </div>

          {answerError && (
            <div className="text-sm text-destructive" data-testid="ask-error">Error: {answerError}</div>
          )}
          {answer && (
            <div className="rounded-md border p-4 bg-muted/40 space-y-2" data-testid="ask-answer">
              <p className="text-sm whitespace-pre-wrap">{answer.answer}</p>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">provider: {answer.provider}</Badge>
                <Badge variant="outline" className="font-mono">model: {answer.model}</Badge>
                <Badge variant="outline">{answer.latency_ms} ms</Badge>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
