import { useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Cake, TrendingUp, Award, Sparkles, BookOpen, HelpCircle, Users, Calendar, Lightbulb } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiGet } from "@/lib/api";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";

type Section =
  | { kind: "hero"; title: string; subtitle: string | null }
  | { kind: "attendance"; rate: number | null; days_present: number; days_expected: number }
  | { kind: "achievements"; items: string[] }
  | { kind: "topics"; strong: string[]; weak: string[] }
  | { kind: "quiz_results"; items: Array<{ title: string; score: number; date: string }> }
  | { kind: "questions"; count: number; sample: string[] }
  | { kind: "class_themes"; items: string[] }
  | { kind: "upcoming"; items: Array<{ label: string; when: string }> }
  | { kind: "school_highlight"; items: Array<{ title: string; body: string | null }> }
  | { kind: "birthday"; name: string; date_label: string }
  | { kind: "practice"; suggestion: string };

type Edition = {
  week_start: string;
  content: {
    hero: Extract<Section, { kind: "hero" }>;
    sections: Section[];
  };
  generated_at: string;
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  } catch {
    return iso;
  }
}

function SectionRender({ section }: { section: Section }) {
  switch (section.kind) {
    case "hero":
      return null;
    case "birthday":
      return (
        <Card className="p-5 rounded-3xl bg-gradient-to-br from-pink-50 to-white border-none shadow-sm">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-2xl bg-pink-100 text-pink-600 flex items-center justify-center">
              <Cake className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Birthday this week</p>
              <p className="text-sm text-gray-600">
                {section.name} — {section.date_label}
              </p>
            </div>
          </div>
        </Card>
      );
    case "attendance":
      return (
        <Card className="p-5 rounded-3xl border-none shadow-sm">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-2xl bg-emerald-100 text-emerald-600 flex items-center justify-center">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-900">Attendance this week</p>
              <p className="text-2xl font-bold text-gray-900 mt-0.5">
                {section.rate == null ? "—" : `${section.rate}%`}
              </p>
              <p className="text-xs text-gray-500">
                {section.days_present} of {section.days_expected} lessons accounted for
              </p>
            </div>
          </div>
        </Card>
      );
    case "achievements":
      return (
        <Card className="p-5 rounded-3xl border-none shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <Award className="w-4 h-4 text-amber-500" />
            <p className="text-sm font-semibold text-gray-900">Achievements</p>
          </div>
          <ul className="space-y-1.5">
            {section.items.map((item, i) => (
              <li key={i} className="text-sm text-gray-700 flex items-start gap-2">
                <Sparkles className="w-3.5 h-3.5 mt-1 text-amber-400 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </Card>
      );
    case "topics":
      if (section.strong.length === 0 && section.weak.length === 0) return null;
      return (
        <Card className="p-5 rounded-3xl border-none shadow-sm">
          <p className="text-sm font-semibold text-gray-900 mb-3">Your subjects</p>
          {section.strong.length > 0 && (
            <div className="mb-3">
              <p className="text-xs text-emerald-600 uppercase font-bold tracking-wide mb-1">Strong</p>
              <div className="flex flex-wrap gap-1.5">
                {section.strong.map((t) => (
                  <span key={t} className="text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded-full">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
          {section.weak.length > 0 && (
            <div>
              <p className="text-xs text-amber-600 uppercase font-bold tracking-wide mb-1">Needs revision</p>
              <div className="flex flex-wrap gap-1.5">
                {section.weak.map((t) => (
                  <span key={t} className="text-xs bg-amber-50 text-amber-700 px-2 py-1 rounded-full">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Card>
      );
    case "quiz_results":
      return (
        <Card className="p-5 rounded-3xl border-none shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <BookOpen className="w-4 h-4 text-primary" />
            <p className="text-sm font-semibold text-gray-900">Quizzes this week</p>
          </div>
          <ul className="space-y-2">
            {section.items.map((q, i) => (
              <li key={i} className="flex items-center justify-between text-sm">
                <span className="text-gray-700 truncate">{q.title}</span>
                <span className={`font-bold ${q.score >= 80 ? "text-emerald-600" : q.score >= 60 ? "text-amber-600" : "text-rose-600"}`}>
                  {q.score}%
                </span>
              </li>
            ))}
          </ul>
        </Card>
      );
    case "questions":
      return (
        <Card className="p-5 rounded-3xl border-none shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <HelpCircle className="w-4 h-4 text-primary" />
            <p className="text-sm font-semibold text-gray-900">Questions this week</p>
          </div>
          <p className="text-2xl font-bold text-gray-900">{section.count}</p>
          {section.sample.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {section.sample.map((q, i) => (
                <li key={i} className="text-xs text-gray-500 italic">
                  &ldquo;{q}&rdquo;
                </li>
              ))}
            </ul>
          )}
        </Card>
      );
    case "class_themes":
      return (
        <Card className="p-5 rounded-3xl border-none shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-4 h-4 text-primary" />
            <p className="text-sm font-semibold text-gray-900">Your class this week</p>
          </div>
          <ul className="space-y-1.5">
            {section.items.map((t, i) => (
              <li key={i} className="text-sm text-gray-700">
                • {t}
              </li>
            ))}
          </ul>
        </Card>
      );
    case "upcoming":
      return (
        <Card className="p-5 rounded-3xl border-none shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <Calendar className="w-4 h-4 text-primary" />
            <p className="text-sm font-semibold text-gray-900">Upcoming</p>
          </div>
          <ul className="space-y-1.5">
            {section.items.map((u, i) => (
              <li key={i} className="flex items-center justify-between text-sm">
                <span className="text-gray-700 truncate">{u.label}</span>
                <span className="text-xs text-gray-500">{fmtDate(u.when)}</span>
              </li>
            ))}
          </ul>
        </Card>
      );
    case "school_highlight":
      return (
        <Card className="p-5 rounded-3xl border-none shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-4 h-4 text-primary" />
            <p className="text-sm font-semibold text-gray-900">This week at school</p>
          </div>
          <ul className="space-y-2">
            {section.items.map((h, i) => (
              <li key={i}>
                <p className="text-sm font-medium text-gray-900">{h.title}</p>
                {h.body && <p className="text-xs text-gray-500 mt-0.5">{h.body}</p>}
              </li>
            ))}
          </ul>
        </Card>
      );
    case "practice":
      return (
        <Card className="p-5 rounded-3xl bg-primary/5 border-none shadow-sm">
          <div className="flex items-start gap-3">
            <div className="w-11 h-11 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
              <Lightbulb className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Try this</p>
              <p className="text-sm text-gray-700">{section.suggestion}</p>
            </div>
          </div>
        </Card>
      );
  }
}

export default function MagazinePage() {
  const [, setLocation] = useLocation();
  const { token } = useAuth();
  const params = useParams<{ childId: string }>();
  const childId = params.childId;

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["magazine", childId],
    queryFn: () => apiGet<{ edition: Edition }>(`/v1/parent/child/${childId}/magazine/latest`),
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
        <h1 className="text-2xl font-bold">{data?.edition.content.hero.title ?? "This week"}</h1>
        <p className="text-sm text-primary-foreground/80 mt-1">
          {data?.edition.content.hero.subtitle ?? "Loading…"}
        </p>
      </div>

      <div className="px-6 -mt-4 relative z-10 space-y-4 pb-8">
        {isLoading && (
          <>
            <Card className="p-6 rounded-3xl shadow-sm border-none">
              <div className="h-24 bg-gray-100 animate-pulse rounded-xl"></div>
            </Card>
            <Card className="p-6 rounded-3xl shadow-sm border-none">
              <div className="h-24 bg-gray-100 animate-pulse rounded-xl"></div>
            </Card>
          </>
        )}
        {error && (
          <Card className="p-6 rounded-3xl border-none">
            <p className="text-sm text-rose-600">
              {error instanceof Error ? error.message : "Couldn't load the magazine"}
            </p>
          </Card>
        )}
        {data?.edition.content.sections.map((section, i) => (
          <SectionRender key={i} section={section} />
        ))}
      </div>
    </Layout>
  );
}
