import { useGetStudents } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Camera, Search } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ApiError, apiErrorText, apiGet, authHeader } from "@/lib/api";

/** Scales a photo down before upload; face matching doesn't need more than ~1280px. */
async function downscalePhoto(file: File, maxSide = 1280): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("couldn't read the photo"))), "image/jpeg", 0.9),
  );
}

/** Enrolled face photos for Teacher Lens lookup, with an upload button. */
function FaceCell({ studentCode, count }: { studentCode: string; count: number }) {
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const enroll = useMutation({
    mutationFn: async (file: File) => {
      const res = await fetch(`${import.meta.env.BASE_URL}api/v1/faces/students/${encodeURIComponent(studentCode)}`, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", ...authHeader() },
        body: await downscalePhoto(file),
      });
      if (!res.ok) throw new ApiError(res.status, await res.text());
      return (await res.json()) as { enrolled: number; faces_in_photo: number };
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["face-counts"] });
      toast({
        title: "Face enrolled",
        description:
          `${studentCode} now has ${result.enrolled} photo${result.enrolled === 1 ? "" : "s"}.` +
          (result.faces_in_photo > 1 ? " The photo had several faces; the largest was used." : ""),
      });
    },
    onError: (err) => toast({ title: "Face not enrolled", description: apiErrorText(err), variant: "destructive" }),
  });

  return (
    <div className="flex items-center justify-end gap-2">
      <Badge variant={count > 0 ? "default" : "secondary"}>{count > 0 ? `${count} photo${count === 1 ? "" : "s"}` : "none"}</Badge>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="user"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) enroll.mutate(file);
        }}
      />
      <Button size="sm" variant="outline" disabled={enroll.isPending} onClick={() => input.current?.click()} data-testid={`button-enroll-face-${studentCode}`}>
        <Camera className="mr-1 h-3.5 w-3.5" />
        {enroll.isPending ? "Enrolling…" : "Add photo"}
      </Button>
    </div>
  );
}

export default function Students() {
  const [search, setSearch] = useState("");
  const [gradeFilter, setGradeFilter] = useState("all");

  // Add debouncing to real app, using direct for now
  const { data, isLoading } = useGetStudents({
    search: search || undefined,
    grade: gradeFilter !== "all" ? gradeFilter : undefined
  });
  const faces = useQuery({
    queryKey: ["face-counts"],
    queryFn: () => apiGet<{ faces: Record<string, number> }>("/v1/faces/enrolled"),
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Students</h1>
          <p className="text-muted-foreground mt-1">
            Manage and view all enrolled students. Add a clear face photo so Teacher Lens recognises each student.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search students..."
                className="pl-8 bg-background"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="w-full sm:w-48">
              <Select value={gradeFilter} onValueChange={setGradeFilter}>
                <SelectTrigger className="bg-background">
                  <SelectValue placeholder="Filter by Grade" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Grades</SelectItem>
                  <SelectItem value="1">Grade 1</SelectItem>
                  <SelectItem value="2">Grade 2</SelectItem>
                  <SelectItem value="3">Grade 3</SelectItem>
                  <SelectItem value="4">Grade 4</SelectItem>
                  <SelectItem value="5">Grade 5</SelectItem>
                  <SelectItem value="6">Grade 6</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student ID</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead className="text-right">Points</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Last Active</TableHead>
                  <TableHead className="text-right">Face (Teacher Lens)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center">Loading students...</TableCell>
                  </TableRow>
                ) : data?.students?.length ? (
                  data.students.map((student) => (
                    <TableRow key={student.id}>
                      <TableCell className="font-medium">{student.student_id}</TableCell>
                      <TableCell>{student.name}</TableCell>
                      <TableCell>Grade {student.grade}</TableCell>
                      <TableCell className="text-right font-semibold">{student.points.toLocaleString()}</TableCell>
                      <TableCell>
                        <Badge variant={student.status === "active" ? "default" : "secondary"} className={student.status === "active" ? "bg-chart-1" : ""}>
                          {student.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground text-sm">
                        {student.last_active ? new Date(student.last_active).toLocaleDateString() : "Never"}
                      </TableCell>
                      <TableCell>
                        <FaceCell studentCode={student.student_id} count={faces.data?.faces[student.student_id] ?? 0} />
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No students found.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
