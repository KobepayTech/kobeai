import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { apiErrorText, apiGet, apiPost } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { QrCode, Printer, Ban, Camera, Users, FileSpreadsheet } from "lucide-react";

// The administrator's side of onboarding: print QR codes, then watch the
// school fill itself in as teachers scan them. Nothing here asks anyone to
// type a list — the typing happens on phones, off photographs.

type Invite = {
  id: number;
  label: string | null;
  role: string;
  max_uses: number;
  uses: number;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
};

type Issued = { token: string; claim_path: string; invite: Invite };

type PaperImport = {
  id: number;
  kind: string;
  status: string;
  class_name: string | null;
  parsed: unknown[];
  created_count: number;
  updated_count: number;
  created_at: string;
  model: string | null;
};

type FaceQueue = { students: Array<{ id: number; name: string; photos: number }>; remaining: number };

function claimUrl(path: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${path}`;
}

export default function OnboardingPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<Issued | null>(null);
  const [qr, setQr] = useState("");

  const invites = useQuery<{ invites: Invite[] }>({
    queryKey: ["onboarding-invites"],
    queryFn: () => apiGet("/v1/onboarding/invites"),
  });
  const imports = useQuery<{ imports: PaperImport[] }>({
    queryKey: ["onboarding-papers"],
    queryFn: () => apiGet("/v1/onboarding/papers"),
  });
  const faces = useQuery<FaceQueue>({
    queryKey: ["onboarding-face-queue"],
    queryFn: () => apiGet("/v1/onboarding/face-queue"),
  });

  const issue = useMutation({
    mutationFn: () =>
      apiPost<Issued>("/v1/onboarding/invites", { label: label.trim(), expires_hours: 72 }),
    onSuccess: (res) => {
      setIssued(res);
      setLabel("");
      qc.invalidateQueries({ queryKey: ["onboarding-invites"] });
    },
    onError: (err) =>
      toast({ variant: "destructive", title: "Could not create the code", description: apiErrorText(err) }),
  });

  const revoke = useMutation({
    mutationFn: (id: number) => apiPost(`/v1/onboarding/invites/${id}/revoke`, {}),
    onSuccess: () => {
      toast({ title: "Code revoked" });
      qc.invalidateQueries({ queryKey: ["onboarding-invites"] });
    },
  });

  useEffect(() => {
    if (!issued) return setQr("");
    QRCode.toDataURL(claimUrl(issued.claim_path), {
      width: 512,
      margin: 1,
      color: { dark: "#1A1A2E", light: "#FFFFFF" },
      errorCorrectionLevel: "M",
    })
      .then(setQr)
      .catch(() => setQr(""));
  }, [issued]);

  const studentsWithFace = (faces.data?.students.length ?? 0) - (faces.data?.remaining ?? 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Staff &amp; Students</h1>
        <p className="text-sm text-muted-foreground">
          Print a code, hand it to a teacher, and the rest of the school sets itself up from
          their phone.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Stat
          icon={Users}
          label="Students on the roll"
          value={faces.data ? String(faces.data.students.length) : "—"}
          hint="From photographed class lists"
        />
        <Stat
          icon={Camera}
          label="Faces enrolled"
          value={faces.data ? `${studentsWithFace}/${faces.data.students.length}` : "—"}
          hint={faces.data?.remaining ? `${faces.data.remaining} still to photograph` : "Complete"}
        />
        <Stat
          icon={FileSpreadsheet}
          label="Sheets read"
          value={imports.data ? String(imports.data.imports.length) : "—"}
          hint="Class lists and subject sheets"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5" /> Teacher sign-up codes
          </CardTitle>
          <CardDescription>
            A teacher scans this with their own phone. It opens a short form — their name, age
            band, the subjects and classes they teach, and what they want K9 to call them — and
            creates their account personalised from the first minute.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label htmlFor="label">Label (printed under the code)</Label>
              <Input
                id="label"
                className="w-64"
                placeholder="Form 2 staff room"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <Button onClick={() => issue.mutate()} disabled={issue.isPending}>
              {issue.isPending ? "Creating…" : "Create a code"}
            </Button>
          </div>

          {issued && (
            <div className="rounded-lg border p-4 print:border-0">
              <div className="flex flex-col items-center gap-3 text-center">
                {qr && <img src={qr} alt="Teacher sign-up QR code" className="h-56 w-56" />}
                <div>
                  <div className="font-semibold">{issued.invite.label ?? "Teacher sign-up"}</div>
                  <div className="text-xs text-muted-foreground break-all">
                    {claimUrl(issued.claim_path)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Valid until {new Date(issued.invite.expires_at).toLocaleString()} ·{" "}
                    {issued.invite.max_uses === 1 ? "one teacher" : `${issued.invite.max_uses} teachers`}
                  </div>
                </div>
                <Button variant="outline" className="print:hidden" onClick={() => window.print()}>
                  <Printer className="mr-2 h-4 w-4" /> Print this code
                </Button>
              </div>
              <p className="mt-3 text-xs text-muted-foreground print:hidden">
                This is the only time the code is shown. Print it now — the server only keeps a
                hash of it.
              </p>
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(invites.data?.invites ?? []).map((inv) => {
                const expired = new Date(inv.expires_at) <= new Date();
                const spent = inv.uses >= inv.max_uses;
                return (
                  <TableRow key={inv.id}>
                    <TableCell>{inv.label ?? "Teacher sign-up"}</TableCell>
                    <TableCell>
                      {inv.uses}/{inv.max_uses}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(inv.expires_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      {inv.revoked_at ? (
                        <Badge variant="secondary">Revoked</Badge>
                      ) : spent ? (
                        <Badge variant="outline">Used</Badge>
                      ) : expired ? (
                        <Badge variant="secondary">Expired</Badge>
                      ) : (
                        <Badge className="bg-emerald-500 hover:bg-emerald-500">Live</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!inv.revoked_at && !spent && !expired && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => revoke.mutate(inv.id)}
                          disabled={revoke.isPending}
                        >
                          <Ban className="mr-2 h-4 w-4" /> Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {(invites.data?.invites.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No codes yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sheets teachers have photographed</CardTitle>
          <CardDescription>
            Class lists and subject-option sheets read off a phone camera. Each one was checked
            by the teacher before it was committed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Rows</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Read by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(imports.data?.imports ?? []).map((imp) => (
                <TableRow key={imp.id}>
                  <TableCell className="text-muted-foreground">
                    {new Date(imp.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>{imp.kind === "roster" ? "Class list" : "Subject options"}</TableCell>
                  <TableCell>{imp.class_name ?? "—"}</TableCell>
                  <TableCell>{Array.isArray(imp.parsed) ? imp.parsed.length : 0}</TableCell>
                  <TableCell>
                    {imp.status === "committed" ? (
                      <span className="text-sm">
                        +{imp.created_count} new, {imp.updated_count} matched
                      </span>
                    ) : (
                      <Badge variant={imp.status === "failed" ? "destructive" : "secondary"}>
                        {imp.status}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{imp.model ?? "line parser"}</TableCell>
                </TableRow>
              ))}
              {(imports.data?.imports.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    Nothing photographed yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 pt-6">
        <div className="rounded-md bg-primary/10 p-3">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div>
          <div className="text-2xl font-bold leading-none">{value}</div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-muted-foreground">{hint}</div>
        </div>
      </CardContent>
    </Card>
  );
}
