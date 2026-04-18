import { useState } from "react";
import { Link } from "wouter";
import { useAuth, type DeveloperProfile } from "@/lib/auth";
import { apiPost, ApiError } from "@/lib/api";

export default function LoginPage() {
  const { login } = useAuth();
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
        "/v1/dev/login",
        { email, password },
      );
      login(res.token, res.developer);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ background: "#1A1A2E" }} className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-white text-3xl font-bold text-center mb-2">
          Kobe<span style={{ color: "#00A86B" }}>AI</span> Developers
        </h1>
        <p className="text-white/70 text-center mb-8 text-sm">
          Build mini-apps for Tanzanian schools.
        </p>
        <div className="card">
          <h2 className="text-xl font-semibold mb-4">Sign in</h2>
          <form onSubmit={onSubmit} className="space-y-4">
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
              />
            </div>
            {err && <p className="text-sm text-red-600">{err}</p>}
            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p className="text-sm text-center mt-4 text-gray-600">
            New here?{" "}
            <Link href="/signup" className="font-semibold" style={{ color: "#00A86B" }}>
              Create a developer account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
