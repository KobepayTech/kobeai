import { useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  BookOpen,
  ClipboardList,
  Sparkles,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";

type Note = {
  id: number;
  topic: string;
  subject: string | null;
  body_markdown: string;
  generator: string;
  created_at: string;
};

type Plan = {
  id: number;
  week_start: string;
  plan_markdown: string;
  generator: string;
  generated_at: string;
};

type Habit = { category: string; n: number };

type Development = {
  child: { id: string; name: string; grade: string | null; student_code: string };
  notes: Note[];
  plan: Plan | null;
  habits: Habit[];
};

const HABIT_STYLE: Record<string, string> = {
  attentive: "bg-emerald-100 text-emerald-700",
  reading: "bg-emerald-100 text-emerald-700",
  writing: "bg-emerald-100 text-emerald-700",
  collaborating: "bg-emerald-100 text-emerald-700",
  drawing: "bg-amber-100 text-amber-700",
  idle: "bg-gray-200 text-gray-700",
  restless: "bg-amber-100 text-amber-700",
  distracted: "bg-rose-100 text-rose-700",
  sleeping: "bg-rose-100 text-rose-700",
};

// Family-safe versions of habit labels; the raw category is close but a
// parent doesn't want to see "distracted" in bold letters about their kid.
const HABIT_LABEL: Record<string, string> = {
  attentive: "Focused",
  reading: "Reading",
  writing: "Writing",
  collaborating: "Group work",
  drawing: "Sketching",
  idle: "Idle",
  restless: "Restless",
  distracted: "Off-task",
  sleeping: "Sleeping in class",
};

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString([], { day: "2-digit", month: "short" });
  } catch {
    return iso;
  }
}

export default function DevelopmentPage() {
  const [, setLocation] = useLocation();
  const { token } = useAuth();
  const params = useParams<{ childId: string }>();
  const childId = params.childId;

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["development", childId],
    queryFn: () => apiGet<Development>(`/v1/parent/child/${childId}/development`),
    enabled: !!token && !!childId,
  });

  if (!token) return null;

  return (
    <Layout>
      <div className="px-6 pt-12 pb-6 bg-primary text-white rounded-b-[40px] shadow-sm">
        <button
          onClick={() => setLocation("/dashboard")}
          className="flex items-center gap-1 text-sm text-primary-foreground/80 mb-3"
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>
        <h1 className="text-2xl font-bold">
          {data?.child?.name ? `${data.child.name}'s development` : "Development"}
        </h1>
        <p className="text-sm text-primary-foreground/80 mt-1">
          What the teacher's AI has learned about your child from marking and prep-time observations.
        </p>
      </div>

      <div className="px-6 -mt-4 relative z-10 space-y-4 pb-8">
        {isLoading && (
          <>
            <Card className="p-6 rounded-3xl shadow-sm border-none">
              <div className="h-24 bg-gray-100 animate-pulse rounded-xl" />
            </Card>
            <Card className="p-6 rounded-3xl shadow-sm border-none">
              <div className="h-24 bg-gray-100 animate-pulse rounded-xl" />
            </Card>
          </>
        )}

        {error && (
          <Card className="p-6 rounded-3xl border-none">
            <p className="text-sm text-rose-600">
              {error instanceof Error ? error.message : "Couldn't load the development digest."}
            </p>
          </Card>
        )}

        {data?.habits && data.habits.length > 0 && (
          <Card className="p-5 rounded-3xl border-none shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-primary" />
              <p className="text-sm font-semibold text-gray-900">Habits this fortnight</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {data.habits.map((h) => (
                <span
                  key={h.category}
                  className={`text-xs font-medium px-3 py-1 rounded-full ${
                    HABIT_STYLE[h.category] ?? "bg-gray-100 text-gray-600"
                  }`}
                >
                  {HABIT_LABEL[h.category] ?? h.category} · {h.n}
                </span>
              ))}
            </div>
          </Card>
        )}

        {data?.plan && (
          <Card className="p-5 rounded-3xl border-none shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <ClipboardList className="w-4 h-4 text-primary" />
              <p className="text-sm font-semibold text-gray-900">
                Teacher's lesson plan · week of {data.plan.week_start}
              </p>
            </div>
            <pre className="whitespace-pre-wrap text-sm font-sans text-gray-700 leading-relaxed">
              {data.plan.plan_markdown}
            </pre>
          </Card>
        )}

        {data?.notes && data.notes.length > 0 && (
          <div className="space-y-3">
            <p className="text-xs uppercase tracking-widest text-gray-500 font-bold px-1 pt-2">
              Notes to read together
            </p>
            {data.notes.map((n) => (
              <Card key={n.id} className="p-5 rounded-3xl border-none shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <BookOpen className="w-4 h-4 text-primary" />
                  <p className="text-sm font-semibold text-gray-900">{n.topic}</p>
                  {n.subject && (
                    <span className="text-xs text-gray-500 ml-1">· {n.subject}</span>
                  )}
                  <span className="text-xs text-gray-400 ml-auto">{fmt(n.created_at)}</span>
                </div>
                <pre className="whitespace-pre-wrap text-sm font-sans text-gray-700 leading-relaxed">
                  {n.body_markdown}
                </pre>
              </Card>
            ))}
          </div>
        )}

        {data && data.notes.length === 0 && !data.plan && (
          <Card className="p-6 rounded-3xl border-none">
            <p className="text-sm text-gray-600">
              Nothing to share yet. As your child's teacher marks papers with KobeAI, this page will fill in
              with topic notes and a weekly lesson plan just for them.
            </p>
          </Card>
        )}
      </div>
    </Layout>
  );
}
