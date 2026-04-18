import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiGet, apiPost, uploadToPresigned, ApiError } from "@/lib/api";
import { FileText, Upload, Loader2, Link2 } from "lucide-react";

type Doc = {
  id: number;
  name: string;
  subject: string;
  pages: number;
  size_bytes: number;
  content_type: string;
  uploaded_by: number;
  created_at: string;
};

type Cls = { id: number; name: string; grade: string; teacher_id: number };

function fmtKb(bytes: number) {
  if (!bytes) return "—";
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function Documents() {
  const { toast } = useToast();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [classes, setClasses] = useState<Cls[]>([]);
  const [loading, setLoading] = useState(true);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("General");
  const [classId, setClassId] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [assignDoc, setAssignDoc] = useState<Doc | null>(null);
  const [assignClassId, setAssignClassId] = useState<string>("");
  const [assignScheduledAt, setAssignScheduledAt] = useState<string>("");
  const [assignExpiresAt, setAssignExpiresAt] = useState<string>("");
  const [assigning, setAssigning] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [d, c] = await Promise.all([
        apiGet<{ documents: Doc[] }>("/v1/teacher/documents"),
        apiGet<{ classes: Cls[] }>("/v1/teacher/classes"),
      ]);
      setDocs(d.documents);
      setClasses(c.classes);
    } catch (e) {
      const msg = e instanceof ApiError ? `(${e.status})` : "";
      toast({ variant: "destructive", title: "Failed to load", description: `Could not fetch documents ${msg}` });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function onUpload() {
    if (!file || !name.trim()) {
      toast({ variant: "destructive", title: "Missing fields", description: "Pick a file and give it a name." });
      return;
    }
    setSubmitting(true);
    try {
      const { upload_url } = await apiPost<{ upload_url: string }>("/v1/teacher/documents/upload-url", {});
      await uploadToPresigned(upload_url, file);
      const class_ids = classId ? [Number(classId)] : [];
      await apiPost("/v1/teacher/documents", {
        name,
        subject,
        size_bytes: file.size,
        content_type: file.type || "application/pdf",
        object_path: upload_url.split("?")[0],
        class_ids,
      });
      toast({ title: "Uploaded", description: `${name} is now available${classId ? " to the selected class" : ""}.` });
      setUploadOpen(false);
      setName(""); setSubject("General"); setClassId(""); setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status}: ${e.message.slice(0, 120)}` : String(e);
      toast({ variant: "destructive", title: "Upload failed", description: msg });
    } finally {
      setSubmitting(false);
    }
  }

  async function onAssign() {
    if (!assignDoc || !assignClassId) return;
    setAssigning(true);
    try {
      // datetime-local values are in the browser's local zone with no offset.
      // Converting via `new Date(value).toISOString()` normalises to UTC for
      // the server, matching what `parseDate` expects on the API.
      const toIso = (v: string) => v ? new Date(v).toISOString() : null;
      await apiPost(`/v1/teacher/documents/${assignDoc.id}/assign`, {
        class_id: Number(assignClassId),
        scheduled_at: toIso(assignScheduledAt),
        expires_at: toIso(assignExpiresAt),
      });
      toast({ title: "Assigned", description: `${assignDoc.name} → ${classes.find(c => c.id === Number(assignClassId))?.name ?? "class"}` });
      setAssignDoc(null);
      setAssignClassId("");
      setAssignScheduledAt("");
      setAssignExpiresAt("");
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status}: ${e.message.slice(0, 120)}` : String(e);
      toast({ variant: "destructive", title: "Assign failed", description: msg });
    } finally {
      setAssigning(false);
    }
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Documents</h1>
          <p className="text-muted-foreground mt-1">Upload PDFs and assign them to classes. Students can tap-to-print assigned documents from their watch.</p>
        </div>
        <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-upload-document"><Upload className="h-4 w-4 mr-2" />Upload PDF</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Upload a document</DialogTitle>
              <DialogDescription>Upload a PDF and optionally assign it to a class right away.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="doc-name">Document name</Label>
                <Input id="doc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Biology Class Notes — Cells" data-testid="input-doc-name" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="doc-subject">Subject</Label>
                <Input id="doc-subject" value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="input-doc-subject" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="doc-class">Assign to class (optional)</Label>
                <Select value={classId} onValueChange={setClassId}>
                  <SelectTrigger data-testid="select-doc-class"><SelectValue placeholder="No class" /></SelectTrigger>
                  <SelectContent>
                    {classes.map((c) => (<SelectItem key={c.id} value={String(c.id)}>{c.name} — {c.grade}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="doc-file">PDF file</Label>
                <Input id="doc-file" type="file" accept="application/pdf,.pdf" ref={fileRef} onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="input-doc-file" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setUploadOpen(false)} disabled={submitting}>Cancel</Button>
              <Button onClick={onUpload} disabled={submitting || !file || !name.trim()} data-testid="button-confirm-upload">
                {submitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Uploading…</> : "Upload"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your documents</CardTitle>
          <CardDescription>{docs.length} total</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="h-5 w-5 mr-2 animate-spin" />Loading…</div>
          ) : docs.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <FileText className="h-12 w-12 mx-auto mb-3 opacity-40" />
              No documents yet. Upload your first PDF to make it available for printing.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((d) => (
                  <TableRow key={d.id} data-testid={`row-doc-${d.id}`}>
                    <TableCell className="font-medium flex items-center gap-2"><FileText className="h-4 w-4 text-muted-foreground" />{d.name}</TableCell>
                    <TableCell><Badge variant="secondary">{d.subject}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{fmtKb(d.size_bytes)}</TableCell>
                    <TableCell className="text-muted-foreground">{new Date(d.created_at).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => { setAssignDoc(d); setAssignClassId(""); }} data-testid={`button-assign-${d.id}`}>
                        <Link2 className="h-4 w-4 mr-1" />Assign
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!assignDoc} onOpenChange={(o) => { if (!o) setAssignDoc(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign to class</DialogTitle>
            <DialogDescription>{assignDoc?.name}</DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-4">
            <div className="space-y-2">
              <Label>Class</Label>
              <Select value={assignClassId} onValueChange={setAssignClassId}>
                <SelectTrigger data-testid="select-assign-class"><SelectValue placeholder="Pick a class" /></SelectTrigger>
                <SelectContent>
                  {classes.map((c) => (<SelectItem key={c.id} value={String(c.id)}>{c.name} — {c.grade}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="assign-scheduled-at">Available from <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <input
                  id="assign-scheduled-at"
                  type="datetime-local"
                  data-testid="input-scheduled-at"
                  value={assignScheduledAt}
                  onChange={(e) => setAssignScheduledAt(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="assign-expires-at">Expires at <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <input
                  id="assign-expires-at"
                  type="datetime-local"
                  data-testid="input-expires-at"
                  value={assignExpiresAt}
                  onChange={(e) => setAssignExpiresAt(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Leave both blank for an always-available document. Set "available from" to schedule homework in advance, or "expires at" to auto-retire stale worksheets.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignDoc(null)} disabled={assigning}>Cancel</Button>
            <Button onClick={onAssign} disabled={assigning || !assignClassId} data-testid="button-confirm-assign">
              {assigning ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Assigning…</> : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
