import { FormEvent, useState } from "react";
import { Link, useLocation } from "wouter";
import { apiPost } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function Signup() {
  const { setToken } = useAuth();
  const [, navigate] = useLocation();
  const [companyName, setCompanyName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const res = await apiPost<{ access_token: string }>("/v1/advertiser/signup", {
        company_name: companyName,
        contact_email: contactEmail,
        contact_phone: contactPhone,
        password,
      });
      setToken(res.access_token);
      navigate("/wallet");
    } catch (e: any) {
      setErr(e.message ?? "Signup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-navy px-6 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-10 h-10 rounded-xl bg-brand flex items-center justify-center text-white font-black text-lg">K</div>
            <span className="text-white font-bold text-xl">KobeAI Ads</span>
          </div>
          <p className="text-white/60 text-sm">Self-serve campaigns from TSh 1/impression</p>
        </div>
        <form onSubmit={onSubmit} className="card space-y-4">
          <h1 className="text-lg font-bold text-navy">Create advertiser account</h1>
          <div>
            <label className="label">Company name</label>
            <input className="input" required value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          </div>
          <div>
            <label className="label">Contact email</label>
            <input className="input" type="email" required value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
          </div>
          <div>
            <label className="label">Contact phone</label>
            <input className="input" required value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="+255…" />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <button className="btn btn-primary w-full" disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </button>
          <div className="text-sm text-center text-muted">
            Already registered?{" "}
            <Link href="/login" className="text-brand font-semibold">
              Sign in
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
