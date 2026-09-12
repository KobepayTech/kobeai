import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiGet, apiErrorText } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { School, ShieldCheck, KeyRound, Copy, ArrowRight } from "lucide-react";

// First-run wizard. A K9 server ships with no accounts: whoever opens the
// dashboard first names the school, picks a setup password, and creates the
// school's own administrator.
//
// Note what this screen does NOT do. It never offers to create an operator
// account, because it cannot: /v1/setup/school always creates role "admin".
// The operator console belongs to KobepayTech and is unlocked out-of-band
// with a secret that only exists in the environment of a server we run.

type SetupState = { needs_setup: boolean; school_name: string | null };

type Created = { school_name: string; license_key: string };

const BASE = import.meta.env.BASE_URL;

export default function SetupPage() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const { data: state, isLoading } = useQuery<SetupState>({
    queryKey: ["setup-state"],
    queryFn: () => apiGet<SetupState>("/v1/setup/state"),
    retry: false,
  });

  const [schoolName, setSchoolName] = useState("");
  const [region, setRegion] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${BASE}api/v1/setup/school`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          school_name: schoolName,
          region,
          setup_password: setupPassword,
          admin_name: adminName,
          admin_email: adminEmail,
          admin_password: adminPassword,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `Setup failed (${res.status})`);
      setCreated(body as Created);
    } catch (err) {
      toast({ variant: "destructive", title: "Setup failed", description: apiErrorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const ready =
    schoolName.trim().length >= 3 &&
    setupPassword.length >= 8 &&
    adminPassword.length >= 8 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail.trim());

  if (isLoading) return null;

  if (created) {
    return (
      <Centered>
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              {created.school_name} is set up
            </CardTitle>
            <CardDescription>
              Write this licence key down and keep it with the server. It is what links this
              school to KobeAI, and it is not shown again.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm break-all">
                {created.license_key}
              </code>
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy licence key"
                onClick={() => {
                  navigator.clipboard
                    .writeText(created.license_key)
                    .then(() => toast({ title: "Licence key copied" }))
                    .catch(() => toast({ variant: "destructive", title: "Copy failed" }));
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Sign in as {adminEmail}.</li>
              <li>Open <strong>Staff &amp; Students</strong> and print the teacher QR codes.</li>
              <li>Teachers scan a code and set themselves up on their own phones.</li>
            </ol>
            <Button className="w-full" onClick={() => setLocation("/login")}>
              Go to sign in <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      </Centered>
    );
  }

  if (state && !state.needs_setup) {
    return (
      <Centered>
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{state.school_name ?? "This school"} is already set up</CardTitle>
            <CardDescription>Sign in with your school account.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={() => setLocation("/login")}>
              Go to sign in
            </Button>
          </CardContent>
        </Card>
      </Centered>
    );
  }

  return (
    <Centered>
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <School className="h-5 w-5 text-primary" />
            Set up this school server
          </CardTitle>
          <CardDescription>
            Two things: what this school is called, and who runs it. Everything else — teachers,
            students, faces, subjects — comes in from phones afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">The school</h3>
            <div className="space-y-2">
              <Label htmlFor="school">School name</Label>
              <Input
                id="school"
                placeholder="Karatu Secondary School"
                value={schoolName}
                onChange={(e) => setSchoolName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="region">Region (optional)</Label>
              <Input
                id="region"
                placeholder="Arusha"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-password" className="flex items-center gap-2">
                <KeyRound className="h-4 w-4" /> Setup password
              </Label>
              <Input
                id="setup-password"
                type="password"
                placeholder="At least 8 characters"
                value={setupPassword}
                onChange={(e) => setSetupPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Not a login. It is the break-glass password for changing this server's setup
                later — keep it with the licence key, not in a staff group chat.
              </p>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">The school administrator</h3>
            <div className="space-y-2">
              <Label htmlFor="admin-name">Full name</Label>
              <Input
                id="admin-name"
                placeholder="Head of School"
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="admin-email">Email</Label>
              <Input
                id="admin-email"
                type="email"
                placeholder="head@school.tz"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="admin-password">Password</Label>
              <Input
                id="admin-password"
                type="password"
                placeholder="At least 8 characters"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
              />
            </div>
          </section>

          <Button className="w-full" disabled={!ready || busy} onClick={submit}>
            {busy ? "Setting up…" : "Create this school"}
          </Button>
        </CardContent>
      </Card>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">{children}</div>
  );
}
