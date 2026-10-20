import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, authHeader, apiErrorText } from "@/lib/api";
import { useMe } from "@/lib/capabilities";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
type Pack = {
  id: number;
  exam_id: number;
  student_id: number;
  name: string;
  student_code: string;
  grade: string;
  subject: string;
  title: string;
  status: string;
  kind: string;
  cost_tsh: number;
  problems: string[];
  hold_reason: string | null;
};
type Lesson = {
  evidence_id: number;
  explanation: string;
  example: string;
  question: string;
};
type Detail = { content: { lessons: Lesson[]; proof: unknown[] } };
export default function LearningPacks() {
  const qc = useQueryClient();
  const { me } = useMe();
  const office = ["admin", "super_admin"].includes(me?.role ?? "");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [exam, setExam] = useState("");
  const [receipt, setReceipt] = useState(""),
    [amount, setAmount] = useState(""),
    [student, setStudent] = useState("");
  const [review, setReview] = useState<{ pack: Pack; detail: Detail } | null>(
      null,
    ),
    [verified, setVerified] = useState(false);
  const data = useQuery({
    queryKey: ["learning-packs"],
    queryFn: () =>
      apiGet<{
        packs: Pack[];
        settings: {
          price_per_side: number;
          printer_id: string;
          auto_print: boolean;
        };
      }>("/v1/learning-packs"),
    refetchInterval: 10000,
  });
  const exams = useQuery({
    queryKey: ["pack-exams"],
    queryFn: () =>
      apiGet<{ exams: { id: number; title: string; subject: string }[] }>(
        "/v1/results/exams",
      ),
  });
  const cash = useQuery({
    queryKey: ["print-cash"],
    queryFn: () =>
      apiGet<{
        accounts: {
          id: number;
          name: string;
          student_code: string;
          balance_tsh: number;
          reserved_tsh: number;
        }[];
      }>("/v1/print-cash/accounts"),
    enabled: office,
  });
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["learning-packs"] });
      await qc.invalidateQueries({ queryKey: ["print-cash"] });
    } catch (e) {
      setError(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function preview(p: Pack) {
    const r = await fetch(
      `${import.meta.env.BASE_URL}api/v1/learning-packs/${p.id}/pdf`,
      { headers: authHeader() },
    );
    if (!r.ok) throw new Error(await r.text());
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `K9-pack-${p.id}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  const colours: Record<string, string> = {
    "1": "#15803d",
    "2": "#2563eb",
    "3": "#dc2626",
    "4": "#eab308",
  };
  const packs = data.data?.packs ?? [];
  return (
    <div className="space-y-6 max-w-6xl">
      <header>
        <h1 className="text-3xl font-bold">Student Learning Packs</h1>
        <p className="text-muted-foreground mt-2">
          One A4 sheet, both sides. Evidence from marked work, explanations and
          targeted practice.
        </p>
      </header>
      {(error || data.error || exams.error || cash.error) && (
        <p role="alert" className="text-red-700">
          {error || apiErrorText(data.error || exams.error || cash.error)}
        </p>
      )}
      <div className="grid grid-cols-3 gap-4">
        {[
          [
            "Awaiting review",
            packs.filter((p) => p.status === "review").length,
          ],
          [
            "Awaiting funds",
            packs.filter((p) => p.status === "awaiting_funds").length,
          ],
          [
            "Ready to collect",
            packs.filter((p) => p.status === "printed").length,
          ],
        ].map(([label, n]) => (
          <Card key={label}>
            <CardContent className="pt-5">
              <p>{label}</p>
              <strong className="text-3xl">{n}</strong>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Finish marking and prepare packs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p>
            Closes the selected exam for marking. Packs are generated
            automatically; uncertain evidence is held for review. Repeating this
            action does not create duplicate packs.
          </p>
          <select
            aria-label="Exam"
            className="border rounded p-2"
            value={exam}
            onChange={(e) => setExam(e.target.value)}
          >
            <option value="">Choose exam</option>
            {exams.data?.exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title} · {e.subject}
              </option>
            ))}
          </select>{" "}
          <Button
            disabled={busy || !exam}
            onClick={() =>
              action(() =>
                apiPost(`/v1/learning-packs/exams/${exam}/complete`, {}),
              )
            }
          >
            Complete marking
          </Button>
          <p className="text-sm">
            Quick pack: TZS {(data.data?.settings.price_per_side ?? 100) * 2}.
            Extended pack on request: TZS{" "}
            {(data.data?.settings.price_per_side ?? 100) * 6}. Subscription
            required separately.
          </p>
        </CardContent>
      </Card>
      {office && (
        <Card>
          <CardHeader>
            <CardTitle>Bursar printing funds</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p>
              Record funds received or transferred by the bursar for printing.
              This ledger does not withdraw from an external Kobepay wallet.
            </p>
            <select
              aria-label="Student printing account"
              className="border rounded p-2 w-full"
              value={student}
              onChange={(e) => setStudent(e.target.value)}
            >
              <option value="">Select student</option>
              {cash.data?.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.student_code} · Available TZS{" "}
                  {a.balance_tsh - a.reserved_tsh} · Reserved {a.reserved_tsh}
                </option>
              ))}
            </select>
            <div className="flex gap-3">
              <Input
                aria-label="Deposit amount in TZS"
                placeholder="Amount TZS"
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <Input
                aria-label="Unique receipt reference"
                placeholder="Receipt reference"
                value={receipt}
                onChange={(e) => setReceipt(e.target.value)}
              />
              <Button
                disabled={busy || !student || !receipt || !amount}
                onClick={() =>
                  action(() =>
                    apiPost("/v1/print-cash/deposits", {
                      student_id: Number(student),
                      amount_tsh: Number(amount),
                      receipt,
                    }),
                  )
                }
              >
                Record funds
              </Button>
            </div>
            {data.data && (
              <form
                className="flex flex-wrap gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void action(() =>
                    apiPost("/v1/learning-packs/settings", {
                      price_per_side: Number(f.get("price")),
                      printer_id: String(f.get("printer")),
                      auto_print: f.get("auto") === "on",
                    }),
                  );
                }}
              >
                <label>
                  Price per side (TZS)
                  <Input
                    name="price"
                    type="number"
                    min="1"
                    max="10000"
                    defaultValue={data.data.settings.price_per_side}
                  />
                </label>
                <label>
                  Printer ID
                  <Input
                    name="printer"
                    defaultValue={data.data.settings.printer_id}
                  />
                </label>
                <label>
                  <input
                    name="auto"
                    type="checkbox"
                    defaultChecked={data.data.settings.auto_print}
                  />{" "}
                  Automatic queue
                </label>
                <Button disabled={busy}>Save settings</Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}
      {review && (
        <Card>
          <CardHeader>
            <CardTitle>
              Review pack #{review.pack.id} · {review.pack.name}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p>{review.pack.problems.join(". ")}</p>
            <details>
              <summary>
                Captured questions, answers, marks and source image references
              </summary>
              <pre className="whitespace-pre-wrap text-sm max-h-96 overflow-auto">
                {JSON.stringify(review.detail.content.proof, null, 2)}
              </pre>
            </details>
            {review.detail.content.lessons.map((l, i) => (
              <fieldset key={l.evidence_id} className="space-y-2">
                <legend>Evidence #{l.evidence_id}</legend>
                {(["explanation", "example", "question"] as const).map((k) => (
                  <label key={k} className="block capitalize">
                    {k}
                    <textarea
                      className="block border rounded w-full p-2"
                      maxLength={500}
                      rows={3}
                      value={l[k]}
                      onChange={(e) => {
                        const lessons = review.detail.content.lessons.map(
                          (v, j) =>
                            j === i ? { ...v, [k]: e.target.value } : v,
                        );
                        setReview({
                          ...review,
                          detail: {
                            content: { ...review.detail.content, lessons },
                          },
                        });
                      }}
                    />
                  </label>
                ))}
              </fieldset>
            ))}
            <label className="block">
              <input
                type="checkbox"
                checked={verified}
                onChange={(e) => setVerified(e.target.checked)}
              />{" "}
              I checked the source paper, student identity, teacher marks,
              correct answers and learning text.
            </label>
            <Button
              disabled={busy || !verified}
              onClick={() =>
                action(async () => {
                  await apiPost(`/v1/learning-packs/${review.pack.id}/review`, {
                    evidence_verified: true,
                    answers_verified: true,
                    lessons: review.detail.content.lessons,
                  });
                  setReview(null);
                })
              }
            >
              Approve pack
            </Button>{" "}
            <Button variant="outline" onClick={() => setReview(null)}>
              Close
            </Button>
          </CardContent>
        </Card>
      )}
      <div className="space-y-3">
        {data.isLoading && <p>Loading packs…</p>}
        {!data.isLoading && !packs.length && (
          <p>No packs yet. Complete marking an exam to start.</p>
        )}
        {packs.map((p) => (
          <Card
            key={p.id}
            style={{
              borderTop: `5px solid ${colours[p.grade.match(/[1-4]/)?.[0] ?? ""] ?? "#475569"}`,
            }}
          >
            <CardContent className="pt-4 flex flex-wrap justify-between gap-4">
              <div>
                <h2 className="font-semibold">
                  {p.name} · {p.student_code}
                </h2>
                <p>
                  {p.grade} · {p.subject} · {p.title}
                </p>
                <p className="text-sm">
                  {p.kind} · {p.status.replaceAll("_", " ")} · TZS{" "}
                  {p.cost_tsh || "—"}
                </p>
                {p.hold_reason && <p className="text-amber-800 text-sm">{p.hold_reason}</p>}
              {p.status === "review" && (
                  <p className="text-amber-800 text-sm">
                    {p.problems.join(" · ")}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                <Button
                  variant="outline"
                  disabled={busy || p.status === "pending"}
                  onClick={() => action(() => preview(p))}
                >
                  PDF preview
                </Button>
                {p.status === "review" && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        setReview({
                          pack: p,
                          detail: await apiGet<Detail>(
                            `/v1/learning-packs/${p.id}`,
                          ),
                        });
                        setVerified(false);
                      })
                    }
                  >
                    Review evidence
                  </Button>
                )}
                {p.kind === "quick" && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      action(() =>
                        apiPost(`/v1/learning-packs/${p.id}/extended`, {
                          accepted_cost_tsh:
                            (data.data?.settings.price_per_side ?? 100) * 6,
                        }),
                      )
                    }
                  >
                    Request extended · TZS{" "}
                    {(data.data?.settings.price_per_side ?? 100) * 6}
                  </Button>
                )}
                {office && ["claimed", "submitted"].includes(p.status) && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      action(() =>
                        apiPost(`/v1/learning-packs/${p.id}/confirm-print`, {
                          printed: true,
                        }),
                      )
                    }
                  >
                    Confirm printed & charge
                  </Button>
                )}
                {office &&
                  ["queued", "claimed", "submitted"].includes(p.status) && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        action(() =>
                          apiPost(`/v1/learning-packs/${p.id}/confirm-print`, {
                            printed: false,
                          }),
                        )
                      }
                    >
                      Failed / release funds
                    </Button>
                  )}
                {office && p.status === "failed" && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      action(() =>
                        apiPost(`/v1/learning-packs/${p.id}/retry`, {
                          confirmed_not_printed: true,
                        }),
                      )
                    }
                  >
                    Not printed · retry
                  </Button>
                )}
                {office && p.status === "printed" && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      action(() =>
                        apiPost(`/v1/learning-packs/${p.id}/collect`, {}),
                      )
                    }
                  >
                    Mark collected
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
