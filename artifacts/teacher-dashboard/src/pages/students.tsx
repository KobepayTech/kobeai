import { useGetStudents } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Search } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function Students() {
  const [search, setSearch] = useState("");
  const [gradeFilter, setGradeFilter] = useState("all");
  
  // Add debouncing to real app, using direct for now
  const { data, isLoading } = useGetStudents({ 
    search: search || undefined,
    grade: gradeFilter !== "all" ? gradeFilter : undefined 
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Students</h1>
          <p className="text-muted-foreground mt-1">Manage and view all enrolled students.</p>
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center">Loading students...</TableCell>
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
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No students found.</TableCell>
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
