import { useEffect, useState } from "react";
import type { TeacherAuth } from "./TeacherWorkspace";

export function useServerConnection(auth: TeacherAuth | null) {
  const [status, setStatus] = useState("Checking school connection…");
  useEffect(() => {
    if (!auth) return;
    let stopped = false;
    let inFlight = false;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let delay = 3000;
    async function check() {
      if (stopped || inFlight || expired) return;
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      controller = new AbortController();
      inFlight = true;
      try {
        const response = await fetch(
          `${auth!.api_base}/api/v1/classroom/context`,
          {
            headers: { authorization: `Bearer ${auth!.token}` },
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(8000),
            ]),
          },
        );
        if (stopped) return;
        if (response.status === 401 || response.status === 403) {
          expired = true;
          setStatus("School sign-in needs attention");
          return;
        }
        if (!response.ok) throw new Error("Server unavailable");
        await response.json();
        if (stopped) return;
        setStatus("School server connected");
        delay = 60_000;
      } catch {
        if (stopped) return;
        setStatus("School server unavailable · retrying");
        delay = Math.min(delay * 2, 60_000);
      } finally {
        inFlight = false;
        if (!stopped && !expired) timer = setTimeout(check, delay);
      }
    }
    setStatus("Checking school connection…");
    void check();
    const resume = () => {
      if (!inFlight) {
        delay = 3000;
        void check();
      }
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [auth]);
  return status;
}
