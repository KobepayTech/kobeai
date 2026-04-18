import { FormEvent, useState } from "react";
import { Link, useLocation } from "wouter";
import { apiPost } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function Login() {
  const { setToken } = useAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const res = await apiPost<{ access_token: string }>("/v1/advertiser/login", { email, password });
      setToken(res.access_token);
      navigate("/dashboard");
    } catch (e: any) {
      setErr(e.message ?? "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-navy px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-10 h-10 rounded-xl bg-brand flex items-center justify-center text-white font-black text-lg">K</div>
            <span className="text-white font-bold text-xl">KobeAI Ads</span>
          </div>
          <p className="text-white/60 text-sm">Reach Tanzanian families &amp; students</p>
        </div>
        <form onSubmit={onSubmit} className="card space-y-4">
          <h1 className="text-lg font-bold text-navy">Sign in</h1>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <button className="btn btn-primary w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <div className="text-sm text-center text-muted">
            New advertiser?{" "}
            <Link href="/signup" className="text-brand font-semibold">
              Create account
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
