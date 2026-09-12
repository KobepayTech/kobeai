import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Cable, CheckCircle2, HelpCircle, Loader2 } from "lucide-react";
import { apiGet } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ModelRow = {
  name: string;
  role: string;
  runtime: string;
  purpose: string | null;
  required: boolean;
  license: string;
  license_note: string | null;
  note: string | null;
  expected_size_mb: number | null;
  expected_sha256: string | null;
  url: string | null;
  kind: "downloaded" | "partial" | "missing";
  path: string | null;
  actual_size_mb?: number;
  connection: "connected" | "not_connected" | "runtime_offline";
  connection_note: string;
};

type Response = {
  models_dir: string;
  base_models_dir: string;
  manifest_path: string;
  runtime: { url: string; reachable: boolean; error: string | null };
  totals: {
    total: number;
    downloaded: number;
    missing: number;
    optional_missing: number;
    partial: number;
    connected: number;
  };
  models: ModelRow[];
};

function kindBadge(kind: ModelRow["kind"], required: boolean) {
  if (kind === "downloaded") return { label: "Ready", variant: "default" as const };
  if (kind === "partial") {
    return {
      label: required ? "Incomplete (required)" : "Incomplete (optional)",
      variant: required ? ("destructive" as const) : ("secondary" as const),
    };
  }
  return {
    label: required ? "Missing (required)" : "Missing (optional)",
    variant: required ? ("destructive" as const) : ("outline" as const),
  };
}

function connectionBadge(connection: ModelRow["connection"]) {
  if (connection === "connected") return { label: "Connected", variant: "default" as const };
  if (connection === "runtime_offline") return { label: "Runtime offline", variant: "destructive" as const };
  return { label: "Not connected", variant: "outline" as const };
}

function licenseBadge(license: string) {
  if (license === "commercial-review-required")
    return { label: "License review required", variant: "destructive" as const };
  return { label: license, variant: "outline" as const };
}

export default function ModelsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-models"],
    queryFn: () => apiGet<Response>("/v1/admin/models"),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">K9 model registry</h1>
        <p className="text-muted-foreground mt-1">
          The on-prem models that power the K9 vision, audio and agent stack. Every location comes
          from <code className="text-xs">config/k9-models.json</code>; this page shows what's actually on disk.
        </p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading registry…</p>}
      {error && (
        <Card>
          <CardContent className="py-8 flex items-center gap-3 text-destructive">
            <AlertTriangle className="w-5 h-5" />
            <span>{error instanceof Error ? error.message : "Failed to load the model registry"}</span>
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Card>
              <CardContent className="p-5 flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold">{data.totals.connected}/{data.totals.total}</div>
                  <div className="text-sm text-muted-foreground">Connected to K9</div>
                </div>
                <Cable className="h-6 w-6 text-muted-foreground" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5 flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold">{data.totals.downloaded}/{data.totals.total}</div>
                  <div className="text-sm text-muted-foreground">On disk</div>
                </div>
                <CheckCircle2 className="h-6 w-6 text-muted-foreground" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5 flex items-center justify-between">
                <div>
                  <div className={"text-2xl font-bold " + (data.totals.missing > 0 ? "text-destructive" : "")}>
                    {data.totals.missing}
                  </div>
                  <div className="text-sm text-muted-foreground">Required not ready</div>
                </div>
                <AlertTriangle className={"h-6 w-6 " + (data.totals.missing > 0 ? "text-destructive" : "text-muted-foreground")} />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5 flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold">{data.totals.optional_missing}</div>
                  <div className="text-sm text-muted-foreground">Optional not ready</div>
                </div>
                <HelpCircle className="h-6 w-6 text-muted-foreground" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5 flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold">{data.totals.partial}</div>
                  <div className="text-sm text-muted-foreground">Incomplete downloads</div>
                </div>
                <Loader2 className="h-6 w-6 text-muted-foreground" />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Models</CardTitle>
              <CardDescription>
                Registry: <code className="text-xs">{data.manifest_path}</code>
                <br />
                K9 models: <code className="text-xs">{data.models_dir}</code>
                <br />
                KobeOS models: <code className="text-xs">{data.base_models_dir}</code>
                <br />
                K9 model runtime: <code className="text-xs">{data.runtime.url}</code>{" "}
                {data.runtime.reachable ? "(running)" : `(not reachable${data.runtime.error ? `: ${data.runtime.error}` : ""})`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Connection</TableHead>
                      <TableHead className="text-right">Size (MB)</TableHead>
                      <TableHead>License</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.models.map((m) => {
                      const kind = kindBadge(m.kind, m.required);
                      const link = connectionBadge(m.connection);
                      const lic = licenseBadge(m.license);
                      return (
                        <TableRow key={m.name}>
                          <TableCell>
                            <div className="font-medium">{m.name}</div>
                            {m.path && (
                              <div className="text-xs text-muted-foreground font-mono break-all max-w-md">{m.path}</div>
                            )}
                            {m.purpose && (
                              <div className="text-xs text-muted-foreground max-w-md">{m.purpose}</div>
                            )}
                            {m.note && (
                              <div className="text-xs text-muted-foreground italic max-w-md mt-1">{m.note}</div>
                            )}
                          </TableCell>
                          <TableCell>{m.role}</TableCell>
                          <TableCell className="text-xs font-mono">{m.runtime}</TableCell>
                          <TableCell>
                            <Badge variant={kind.variant}>{kind.label}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={link.variant}>{link.label}</Badge>
                            <div className="text-xs text-muted-foreground max-w-xs mt-1">{m.connection_note}</div>
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {m.actual_size_mb ?? m.expected_size_mb ?? "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant={lic.variant}>{lic.label}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Operator commands</CardTitle>
              <CardDescription>
                Models are managed from a command prompt on the K9 PC, not from this page — downloads are
                gigabytes, and some models are gated behind license terms a person must accept.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>
                <code className="text-xs">scripts\k9-model-status.cmd</code>
                {" — "}the same readiness view as this page.
              </div>
              <div>
                <code className="text-xs">node scripts\k9-models.mjs layout</code>
                {" — "}preview moving folders to match the registry (add <code>--apply</code> to do it).
              </div>
              <div>
                <code className="text-xs">scripts\download-k9-all-ai-except-qwen.cmd</code>
                {" — "}align folders, then download everything missing (never touches Qwen).
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
