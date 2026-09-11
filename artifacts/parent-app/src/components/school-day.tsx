import { useQuery } from "@tanstack/react-query";
import { LogIn, LogOut, CheckCircle2, Clock, MapPin, Camera as CameraIcon } from "lucide-react";
import { apiGet } from "@/lib/api";

type SchoolDayLesson = {
  period_id: number;
  subject: string;
  class_name: string;
  room: string | null;
  start_minute: number;
  end_minute: number;
  status:
    | "on_schedule"
    | "wrong_location"
    | "not_seen"
    | "low_confidence"
    | "no_timetable"
    | "configuration_missing"
    | "insufficient_camera_coverage"
    | null;
  seen_at: string | null;
  expected_zone_name: string | null;
  seen_zone_name: string | null;
  pending: boolean;
};

type SchoolDaySummary = {
  student_code: string;
  student_name: string;
  school_date: string | null;
  arrival: { at: string; zone_name: string | null; camera_id: string | null } | null;
  departure: { at: string; zone_name: string | null; camera_id: string | null } | null;
  lessons: SchoolDayLesson[];
  summary: {
    total_periods_today: number;
    accounted_for: number;
    pending: number;
    not_seen: number;
    camera_coverage_issues: number;
    sightings_today: number;
    day_is_over: boolean;
  };
};

function minuteOfDayToLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeLabel(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function statusPill(status: SchoolDayLesson["status"]): { label: string; classes: string } {
  switch (status) {
    case "on_schedule":
      return { label: "Accounted for", classes: "bg-emerald-100 text-emerald-700" };
    case "wrong_location":
      return { label: "Different room", classes: "bg-amber-100 text-amber-700" };
    case "low_confidence":
      return { label: "Being verified", classes: "bg-amber-100 text-amber-700" };
    case "not_seen":
      return { label: "Not seen", classes: "bg-rose-100 text-rose-700" };
    case "insufficient_camera_coverage":
      return { label: "Camera issue", classes: "bg-gray-100 text-gray-600" };
    case "configuration_missing":
      return { label: "Setup pending", classes: "bg-gray-100 text-gray-600" };
    case "no_timetable":
      return { label: "No lesson", classes: "bg-gray-100 text-gray-600" };
    case null:
      return { label: "Upcoming", classes: "bg-primary/10 text-primary" };
  }
}

export function SchoolDayCard({ childId }: { childId: string | number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["school-day", String(childId)],
    queryFn: () => apiGet<SchoolDaySummary>(`/v1/parent/child/${childId}/school-day`),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="mt-6 bg-gray-50 rounded-2xl p-4 animate-pulse">
        <div className="h-4 w-32 bg-gray-200 rounded mb-2" />
        <div className="h-3 w-full bg-gray-200 rounded" />
      </div>
    );
  }
  if (error || !data) return null;

  const s = data.summary;
  const hasSignal = data.arrival !== null || data.lessons.length > 0 || s.sightings_today > 0;
  if (!hasSignal) return null;

  return (
    <div className="mt-6 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-gray-50 rounded-2xl p-4">
          <div className="flex items-center gap-2 text-gray-500 mb-1 text-sm">
            <LogIn className="w-4 h-4 text-emerald-500" />
            Arrival
          </div>
          <p className="text-lg font-bold text-gray-900">{timeLabel(data.arrival?.at ?? null)}</p>
          {data.arrival?.zone_name && (
            <p className="text-xs text-gray-500 mt-0.5">{data.arrival.zone_name}</p>
          )}
        </div>
        <div className="bg-gray-50 rounded-2xl p-4">
          <div className="flex items-center gap-2 text-gray-500 mb-1 text-sm">
            <LogOut className="w-4 h-4 text-gray-500" />
            Departure
          </div>
          <p className="text-lg font-bold text-gray-900">
            {data.departure ? timeLabel(data.departure.at) : s.day_is_over ? "—" : "Still at school"}
          </p>
          {data.departure?.zone_name && (
            <p className="text-xs text-gray-500 mt-0.5">{data.departure.zone_name}</p>
          )}
        </div>
      </div>

      {data.lessons.length > 0 && (
        <div className="bg-white border border-gray-100 rounded-2xl divide-y divide-gray-100">
          <div className="px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-gray-900">Today's lessons</p>
              <p className="text-xs text-gray-500">
                {s.accounted_for}/{s.total_periods_today} accounted for
                {s.camera_coverage_issues > 0 && ` · ${s.camera_coverage_issues} camera issue${s.camera_coverage_issues === 1 ? "" : "s"}`}
              </p>
            </div>
            <CheckCircle2 className="w-5 h-5 text-emerald-500" />
          </div>
          <ul>
            {data.lessons.map((lesson) => {
              const pill = statusPill(lesson.status);
              return (
                <li key={lesson.period_id} className="px-4 py-3 flex items-center gap-3">
                  <div className="w-14 shrink-0 text-xs font-mono text-gray-500">
                    <div>{minuteOfDayToLabel(lesson.start_minute)}</div>
                    <div className="text-gray-400">{minuteOfDayToLabel(lesson.end_minute)}</div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{lesson.subject}</p>
                    <p className="text-xs text-gray-500 truncate flex items-center gap-1">
                      {lesson.seen_zone_name || lesson.expected_zone_name || lesson.room ? (
                        <>
                          <MapPin className="w-3 h-3" />
                          {lesson.seen_zone_name || lesson.expected_zone_name || lesson.room}
                        </>
                      ) : (
                        <>
                          <Clock className="w-3 h-3" />
                          {lesson.class_name}
                        </>
                      )}
                    </p>
                  </div>
                  <span className={`text-[10px] font-bold tracking-wide uppercase px-2 py-1 rounded-full ${pill.classes}`}>
                    {pill.label}
                  </span>
                </li>
              );
            })}
          </ul>
          {s.camera_coverage_issues > 0 && (
            <div className="px-4 py-3 flex items-start gap-2 text-xs text-gray-500 bg-gray-50">
              <CameraIcon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                A camera issue means the school couldn't get an automatic reading for that lesson — the
                office has been notified and it isn't recorded against your child.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
