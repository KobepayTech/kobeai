import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Cpu, HelpCircle } from "lucide-react";
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
  kind: "downloaded" | "missing" | "algorithm-only";
  path: string | null;
  actual_size_mb?: number;
};

type Response = {
  models_dir: string;
  manifest_path: string;
  totals: {
    total: number;
    downloaded: number;
    missing: number;
    optional_missing: number;
    algorithm_only: number;
  };
  models: ModelRow[];
};

function kindBadge(kind: ModelRow["kind"], required: boolean) {
  if (kind === "downloaded") return { label: "Downloaded", variant: "default" as const };
  if (kind === "algorithm-only") return { label: "Algorithm only", variant: "secondary" as const };
  return {
    label: required ? "Missing (required)" : "Missing (optional)",
    variant: required ? ("destructive" as const) : ("outline" as const),
  };
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
          The on-prem models that power the K9 vision + audio cascade. This page shows
          what the school-server expects to run and what's actually on disk.
        </p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading manifest…</p>}
      {error && (
        <Card>
          <CardContent className="py-8 flex items-center gap-3 text-destructive">
            <AlertTriangle className="w-5 h-5" />
            <span>{error instanceof Error ? error.message : "Failed to load manifest"}</span>
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardContent className="p-5 flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold">{data.totals.downloaded}/{data.totals.total}</div>
                  <div className="text-sm text-muted-foreground">Downloaded</div>
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
                  <div className="text-sm text-muted-foreground">Missing (required)</div>
                </div>
                <AlertTriangle className={"h-6 w-6 " + (data.totals.missing > 0 ? "text-destructive" : "text-muted-foreground")} />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5 flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold">{data.totals.optional_missing}</div>
                  <div className="text-sm text-muted-foreground">Missing (optional)</div>
                </div>
                <HelpCircle className="h-6 w-6 text-muted-foreground" />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5 flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold">{data.totals.algorithm_only}</div>
                  <div className="text-sm text-muted-foreground">Algorithm-only</div>
                </div>
                <Cpu className="h-6 w-6 text-muted-foreground" />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Models</CardTitle>
              <CardDescription>
                Manifest: <code className="text-xs">{data.manifest_path}</code>
                <br />
                On-disk dir: <code className="text-xs">{data.models_dir}</code>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Runtime</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Size (MB)</TableHead>
                      <TableHead>License</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.models.map((m) => {
                      const kind = kindBadge(m.kind, m.required);
                      const lic = licenseBadge(m.license);
                      return (
                        <TableRow key={m.name}>
                          <TableCell>
                            <div className="font-medium">{m.name}</div>
                            {m.purpose && (
                              <div className="text-xs text-muted-foreground max-w-md">
                                {m.purpose}
                              </div>
                            )}
                            {m.note && (
                              <div className="text-xs text-muted-foreground italic max-w-md mt-1">
                                {m.note}
                              </div>
                            )}
                            {m.license_note && (
                              <div className="text-xs text-destructive/80 max-w-md mt-1">
                                {m.license_note}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>{m.role}</TableCell>
                          <TableCell className="text-xs font-mono">{m.runtime}</TableCell>
                          <TableCell>
                            <Badge variant={kind.variant}>{kind.label}</Badge>
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
                Model files are downloaded from the school-server shell, not from this UI —
                one, downloads are gigabytes and don't belong in a browser tab; two, the
                license flags on some models require a human decision each time.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>
                <code className="text-xs">pnpm --filter @workspace/scripts models list</code>
                {" — "}same view as this page, from the shell.
              </div>
              <div>
                <code className="text-xs">pnpm --filter @workspace/scripts models check</code>
                {" — "}sha-256-verify what's on disk.
              </div>
              <div>
                <code className="text-xs">pnpm --filter @workspace/scripts models download</code>
                {" — "}fetch every missing model (respects <code>KOBEAI_MODELS_DIR</code> and per-model{" "}
                <code>KOBEAI_MODEL_URL_*</code> env overrides).
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
