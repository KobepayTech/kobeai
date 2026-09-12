import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Plus, Trash2 } from "lucide-react";
import { apiErrorText, apiGet, apiPost, apiPut } from "@/lib/api";
import {
  METHOD_LABEL,
  SCORE_METHODS,
  fmtDate,
  type GradeBand,
  type GradingScheme,
  type ResultsSettings,
  type Term,
  type TvScoreboardMode,
} from "@/lib/results";
import { useToast } from "@/hooks/use-toast";
import { GradeBadge } from "@/components/results/scoreboard-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const TV_LABEL: Record<TvScoreboardMode, string> = {
  off: "Off — no scoreboard on classroom TVs",
  top5: "Top 5 per subject and overall",
  full: "Full class ranking",
};

type BandDraft = { grade: string; min: string; points: string; remark: string };

const toDraft = (bands: GradeBand[]): BandDraft[] =>
  bands.map((b) => ({ grade: b.grade, min: String(b.min), points: b.points === undefined ? "" : String(b.points), remark: b.remark ?? "" }));

function TermsCard({ terms, isAdmin }: { terms: Term[]; isAdmin: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const year = String(new Date().getFullYear());
  const [form, setForm] = useState({ name: "", academic_year: year, starts_on: "", ends_on: "", is_current: terms.length === 0 });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["results", "terms"] });
    for (const key of ["results-exams", "results-board", "results-card"]) qc.invalidateQueries({ queryKey: [key] });
  };

  const create = useMutation({
    mutationFn: () =>
      apiPost<{ term: Term }>("/v1/results/terms", {
        ...form,
        starts_on: form.starts_on || undefined,
        ends_on: form.ends_on || undefined,
      }),
    onSuccess: () => {
      refresh();
      setForm({ name: "", academic_year: year, starts_on: "", ends_on: "", is_current: false });
      toast({ title: "Term added" });
    },
    onError: (err) => toast({ title: "Couldn't add the term", description: apiErrorText(err), variant: "destructive" }),
  });

  const makeCurrent = useMutation({
    mutationFn: (id: number) => apiPost(`/v1/results/terms/${id}/current`, {}),
    onSuccess: refresh,
    onError: (err) => toast({ title: "Couldn't change the current term", description: apiErrorText(err), variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Academic terms</CardTitle>
        <CardDescription>Exams, scoreboards and report cards are grouped by term. The current term is shown by default.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {terms.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Term</TableHead>
                <TableHead>Year</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {terms.map((term) => (
                <TableRow key={term.id}>
                  <TableCell className="font-medium">{term.name}</TableCell>
                  <TableCell>{term.academic_year}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {fmtDate(term.starts_on)} – {fmtDate(term.ends_on)}
                  </TableCell>
                  <TableCell className="text-right">
                    {term.is_current ? (
                      <Badge>
                        <CheckCircle2 className="mr-1 h-3 w-3" /> Current
                      </Badge>
                    ) : (
                      isAdmin && (
                        <Button size="sm" variant="outline" disabled={makeCurrent.isPending} onClick={() => makeCurrent.mutate(term.id)}>
                          Make current
                        </Button>
                      )
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {isAdmin ? (
          <form
            className="grid items-end gap-3 rounded-lg border p-4 md:grid-cols-6"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="term-name">New term</Label>
              <Input id="term-name" placeholder="Term 1" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="term-year">Year</Label>
              <Input id="term-year" value={form.academic_year} onChange={(e) => setForm((f) => ({ ...f, academic_year: e.target.value }))} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="term-start">Starts</Label>
              <Input id="term-start" type="date" value={form.starts_on} onChange={(e) => setForm((f) => ({ ...f, starts_on: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="term-end">Ends</Label>
              <Input id="term-end" type="date" value={form.ends_on} onChange={(e) => setForm((f) => ({ ...f, ends_on: e.target.value }))} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={form.is_current} onCheckedChange={(is_current) => setForm((f) => ({ ...f, is_current }))} />
                Current
              </label>
              <Button type="submit" size="sm" disabled={create.isPending} data-testid="button-add-term">
                Add
              </Button>
            </div>
          </form>
        ) : (
          terms.length === 0 && <p className="text-sm text-muted-foreground">No terms yet — ask a school admin to add the current term.</p>
        )}
      </CardContent>
    </Card>
  );
}

function CalculationCard({ settings, schemes, isAdmin }: { settings: ResultsSettings; schemes: GradingScheme[]; isAdmin: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    official_method: settings.official_method,
    ca_weight: String(settings.ca_weight),
    exam_weight: String(settings.exam_weight),
    tv_scoreboard: settings.tv_scoreboard,
    primary_scheme_id: settings.primary_scheme ? String(settings.primary_scheme.id) : "",
  });

  const save = useMutation({
    mutationFn: () =>
      apiPut<{ settings: ResultsSettings }>("/v1/results/settings", {
        official_method: form.official_method,
        ca_weight: Number(form.ca_weight),
        exam_weight: Number(form.exam_weight),
        tv_scoreboard: form.tv_scoreboard,
        ...(form.primary_scheme_id ? { primary_scheme_id: Number(form.primary_scheme_id) } : {}),
      }),
    onSuccess: () => {
      for (const key of ["results-settings", "results-board", "results-card"]) qc.invalidateQueries({ queryKey: [key] });
      toast({ title: "Results settings saved", description: "Scoreboards and report cards now use the new rules." });
    },
    onError: (err) => toast({ title: "Couldn't save settings", description: apiErrorText(err), variant: "destructive" }),
  });

  const weightTotal = Number(form.ca_weight) + Number(form.exam_weight);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Official results</CardTitle>
        <CardDescription>
          The school's method and grading scale decide the official score, grade and position. The other methods and NECTA grades stay visible
          so students can see where they stand.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset disabled={!isAdmin} className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Official subject score</Label>
            <Select value={form.official_method} onValueChange={(v) => setForm((f) => ({ ...f, official_method: v as typeof f.official_method }))}>
              <SelectTrigger disabled={!isAdmin} data-testid="select-official-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCORE_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="ca-weight">CA weight %</Label>
              <Input id="ca-weight" type="number" min={0} max={100} value={form.ca_weight} onChange={(e) => setForm((f) => ({ ...f, ca_weight: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="exam-weight">Terminal weight %</Label>
              <Input id="exam-weight" type="number" min={0} max={100} value={form.exam_weight} onChange={(e) => setForm((f) => ({ ...f, exam_weight: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>School grading scale</Label>
            <Select value={form.primary_scheme_id} onValueChange={(v) => setForm((f) => ({ ...f, primary_scheme_id: v }))}>
              <SelectTrigger disabled={!isAdmin}>
                <SelectValue placeholder="Choose a scale" />
              </SelectTrigger>
              <SelectContent>
                {schemes.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Classroom TV scoreboard</Label>
            <Select value={form.tv_scoreboard} onValueChange={(v) => setForm((f) => ({ ...f, tv_scoreboard: v as TvScoreboardMode }))}>
              <SelectTrigger disabled={!isAdmin} data-testid="select-tv-scoreboard">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TV_LABEL) as TvScoreboardMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {TV_LABEL[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </fieldset>
        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {weightTotal !== 100 && form.official_method === "weighted"
              ? `Weights add up to ${weightTotal}% — they are scaled to 100% when scores are calculated.`
              : "Parents see only their own child's results. TVs never show student codes."}
          </p>
          {isAdmin ? (
            <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-results-settings">
              {save.isPending ? "Saving…" : "Save settings"}
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">Only school admins can change these.</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SchemeDialog({
  open,
  onOpenChange,
  scheme,
  template,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scheme: GradingScheme | null;
  template: GradeBand[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [bands, setBands] = useState<BandDraft[]>([]);

  useEffect(() => {
    if (!open) return;
    setName(scheme?.name ?? "");
    setBands(toDraft(scheme?.bands ?? template));
  }, [open, scheme, template]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        bands: bands.map((b) => ({
          grade: b.grade,
          min: Number(b.min),
          ...(b.points.trim() !== "" ? { points: Number(b.points) } : {}),
          ...(b.remark.trim() !== "" ? { remark: b.remark.trim() } : {}),
        })),
      };
      return scheme ? apiPut(`/v1/results/grading-schemes/${scheme.id}`, body) : apiPost("/v1/results/grading-schemes", body);
    },
    onSuccess: () => {
      for (const key of ["results-schemes", "results-settings", "results-board", "results-card"]) qc.invalidateQueries({ queryKey: [key] });
      toast({ title: "Grading scale saved" });
      onOpenChange(false);
    },
    onError: (err) => toast({ title: "Couldn't save the scale", description: apiErrorText(err), variant: "destructive" }),
  });

  const patch = (i: number, key: keyof BandDraft, value: string) =>
    setBands((prev) => prev.map((band, j) => (j === i ? { ...band, [key]: value } : band)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{scheme ? `Edit ${scheme.name}` : "New grading scale"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="scheme-name">Name</Label>
            <Input id="scheme-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="School scale" />
          </div>
          <div className="space-y-2">
            <div className="grid grid-cols-[5rem_6rem_5rem_1fr_2.5rem] gap-2 text-xs font-medium text-muted-foreground">
              <span>Grade</span>
              <span>From score</span>
              <span>Points</span>
              <span>Remark</span>
              <span />
            </div>
            {bands.map((band, i) => (
              <div key={i} className="grid grid-cols-[5rem_6rem_5rem_1fr_2.5rem] gap-2">
                <Input value={band.grade} onChange={(e) => patch(i, "grade", e.target.value)} />
                <Input type="number" min={0} max={100} step="any" value={band.min} onChange={(e) => patch(i, "min", e.target.value)} />
                <Input type="number" min={0} step="any" value={band.points} onChange={(e) => patch(i, "points", e.target.value)} />
                <Input value={band.remark} onChange={(e) => patch(i, "remark", e.target.value)} />
                <Button variant="ghost" size="icon" onClick={() => setBands((prev) => prev.filter((_, j) => j !== i))} aria-label="Remove band">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setBands((prev) => [...prev, { grade: "", min: "", points: "", remark: "" }])}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add band
            </Button>
            <p className="text-xs text-muted-foreground">A score gets the highest band it reaches. One band must start at 0.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save scale"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SchemesCard({ isAdmin, primaryId }: { isAdmin: boolean; primaryId: number | null }) {
  const [editing, setEditing] = useState<GradingScheme | null>(null);
  const [open, setOpen] = useState(false);
  const schemes = useQuery({
    queryKey: ["results-schemes"],
    queryFn: () => apiGet<{ schemes: GradingScheme[]; necta: { o_level: GradeBand[]; a_level: GradeBand[] } }>("/v1/results/grading-schemes"),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Grading scales</CardTitle>
          <CardDescription>School-defined bands. NECTA O-level and A-level scales are built in and always shown alongside.</CardDescription>
        </div>
        {isAdmin && (
          <Button
            variant="outline"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> New scale
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {schemes.isLoading || !schemes.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            {schemes.data.schemes.map((scheme) => (
              <div key={scheme.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 font-medium">
                    {scheme.name}
                    {scheme.id === primaryId && <Badge>Official</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {scheme.bands.map((band) => (
                      <span key={band.grade} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <GradeBadge grade={band.grade} /> {band.min}+
                      </span>
                    ))}
                  </div>
                </div>
                {isAdmin && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(scheme);
                      setOpen(true);
                    }}
                  >
                    Edit
                  </Button>
                )}
              </div>
            ))}
            {(["o_level", "a_level"] as const).map((level) => (
              <div key={level} className="rounded-lg border border-dashed p-3">
                <div className="mb-2 text-sm font-medium">{level === "o_level" ? "NECTA O-level (CSEE)" : "NECTA A-level (ACSEE)"}</div>
                <div className="flex flex-wrap gap-2">
                  {schemes.data.necta[level].map((band) => (
                    <span key={band.grade} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <GradeBadge grade={band.grade} /> {band.min}+ · {band.points} pt
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </CardContent>
      <SchemeDialog open={open} onOpenChange={setOpen} scheme={editing} template={schemes.data?.necta.o_level ?? []} />
    </Card>
  );
}

export function SettingsPanel({ terms, isAdmin }: { terms: Term[]; isAdmin: boolean }) {
  const settings = useQuery({
    queryKey: ["results-settings"],
    queryFn: () => apiGet<{ settings: ResultsSettings; schemes: GradingScheme[] }>("/v1/results/settings"),
  });

  return (
    <div className="space-y-6">
      <TermsCard terms={terms} isAdmin={isAdmin} />
      {settings.data ? (
        <CalculationCard
          key={JSON.stringify(settings.data.settings)}
          settings={settings.data.settings}
          schemes={settings.data.schemes}
          isAdmin={isAdmin}
        />
      ) : (
        <Skeleton className="h-48 w-full" />
      )}
      <SchemesCard isAdmin={isAdmin} primaryId={settings.data?.settings.primary_scheme?.id ?? null} />
    </div>
  );
}
