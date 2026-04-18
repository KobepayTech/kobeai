import { useState } from "react";
import { Link } from "wouter";
import { useAuth, type DeveloperProfile } from "@/lib/auth";
import { apiPost, ApiError } from "@/lib/api";

export default function SignupPage() {
  const { login } = useAuth();
  const [display_name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const res = await apiPost<{ token: string; developer: DeveloperProfile }>(
        "/v1/dev/signup",
        { display_name, email, password },
      );
      login(res.token, res.developer);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Signup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ background: "#1A1A2E" }} className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-white text-3xl font-bold text-center mb-2">
          Become a Kobe<span style={{ color: "#00A86B" }}>AI</span> Developer
        </h1>
        <p className="text-white/70 text-center mb-6 text-sm">
          70% revenue share on paid mini-apps. Plans start at TSh 50,000/yr.
        </p>
        <div className="card">
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="label">Display name</label>
              <input className="input" value={display_name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <label className="label">Email</label>
              <input
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">Password</label>
              <input
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
              <p className="text-xs text-gray-500 mt-1">Minimum 8 characters.</p>
            </div>
            {err && <p className="text-sm text-red-600">{err}</p>}
            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? "Creating account…" : "Create account"}
            </button>
          </form>
          <p className="text-sm text-center mt-4 text-gray-600">
            Already a developer?{" "}
            <Link href="/login" className="font-semibold" style={{ color: "#00A86B" }}>
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
