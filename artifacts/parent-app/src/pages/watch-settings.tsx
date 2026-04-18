import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { apiGet, apiPatch } from "@/lib/api";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ChevronLeft, Volume2, Keyboard, Loader2 } from "lucide-react";
import { useGetParentDashboard } from "@workspace/api-client-react";

type Settings = {
  student_code: string;
  audio_enabled: boolean;
  keyboard_enabled: boolean;
};

/**
 * Watch settings page — one card per child with two toggles:
 *   - Audio responses (TTS via paired earbuds)
 *   - Keyboard input  (BT keyboard typing on chat)
 *
 * Both default to ON server-side, so a brand-new student gets the full
 * experience until a parent dials it back. Saves are PATCHed individually
 * per toggle so a slow network can't undo the other change.
 */
export default function WatchSettings() {
  const [, setLocation] = useLocation();
  const { token } = useAuth();
  const { data: dashboard } = useGetParentDashboard({
    request: { headers: { Authorization: `Bearer ${token ?? ""}` } },
  });
  const [settings, setSettings] = useState<Record<string, Settings>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  useEffect(() => {
    if (!dashboard?.children) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const next: Record<string, Settings> = {};
      for (const child of dashboard.children) {
        try {
          const s = await apiGet<Settings>(`/v1/parent/child/${child.id}/settings`);
          next[String(child.id)] = s;
        } catch {
          // Treat fetch errors as "defaults" so the toggles still render.
          next[String(child.id)] = {
            student_code: "",
            audio_enabled: true,
            keyboard_enabled: true,
          };
        }
      }
      if (!cancelled) {
        setSettings(next);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dashboard?.children]);

  async function update(
    childId: string,
    field: "audio_enabled" | "keyboard_enabled",
    value: boolean,
  ) {
    const key = `${childId}:${field}`;
    setSavingKey(key);
    // Optimistic UI: flip immediately, roll back on error so the parent gets
    // instant feedback even on a slow rural connection.
    setSettings((prev) => ({
      ...prev,
      [childId]: { ...prev[childId]!, [field]: value },
    }));
    try {
      const updated = await apiPatch<Settings>(
        `/v1/parent/child/${childId}/settings`,
        { [field]: value },
      );
      setSettings((prev) => ({ ...prev, [childId]: updated }));
    } catch {
      setSettings((prev) => ({
        ...prev,
        [childId]: { ...prev[childId]!, [field]: !value },
      }));
    } finally {
      setSavingKey(null);
    }
  }

  if (!token) return null;

  return (
    <Layout>
      <div className="p-6">
        <button
          onClick={() => setLocation("/profile")}
          className="flex items-center text-gray-600 mb-4"
        >
          <ChevronLeft className="w-5 h-5" />
          <span className="text-sm">Back</span>
        </button>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Watch Settings</h1>
        <p className="text-gray-500 text-sm mb-6">
          Control how your child's KobeAI watch behaves. Changes apply the next time
          they open the app.
        </p>

        {loading || !dashboard?.children ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            {dashboard.children.map((child) => {
              const s = settings[String(child.id)];
              if (!s) return null;
              return (
                <Card
                  key={child.id}
                  className="rounded-3xl border-gray-100 shadow-sm overflow-hidden"
                >
                  <div className="p-4 border-b border-gray-100">
                    <h2 className="font-semibold text-gray-900">{child.name}</h2>
                    <p className="text-xs text-gray-500">{child.grade}</p>
                  </div>
                  <ToggleRow
                    icon={<Volume2 className="w-5 h-5 text-primary" />}
                    label="Audio responses"
                    description="KobeAI speaks answers through paired earbuds."
                    checked={s.audio_enabled}
                    saving={savingKey === `${child.id}:audio_enabled`}
                    onChange={(v) => update(String(child.id), "audio_enabled", v)}
                  />
                  <ToggleRow
                    icon={<Keyboard className="w-5 h-5 text-primary" />}
                    label="Keyboard input"
                    description="Allow typing on a paired Bluetooth keyboard."
                    checked={s.keyboard_enabled}
                    saving={savingKey === `${child.id}:keyboard_enabled`}
                    onChange={(v) =>
                      update(String(child.id), "keyboard_enabled", v)
                    }
                  />
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}

function ToggleRow({
  icon,
  label,
  description,
  checked,
  saving,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  checked: boolean;
  saving: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between p-4 border-b border-gray-100 last:border-b-0">
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="font-medium text-gray-900">{label}</p>
          <p className="text-xs text-gray-500 mt-0.5">{description}</p>
        </div>
      </div>
      <div className="ml-3 flex items-center gap-2">
        {saving && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
        <Switch checked={checked} onCheckedChange={onChange} disabled={saving} />
      </div>
    </div>
  );
}
