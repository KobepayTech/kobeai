import { useGetAttendance } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { format } from "date-fns";

export default function Attendance() {
  const [date, setDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const { data, isLoading } = useGetAttendance({ date });

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Attendance</h1>
          <p className="text-muted-foreground mt-1">Daily smartwatch check-ins and points awarded.</p>
        </div>
        <div className="flex items-center gap-2">
          <Input 
            type="date" 
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-auto bg-background"
          />
        </div>
      </div>

      {data && (
        <div className="grid gap-4 md:grid-cols-3 mb-6">
          <Card>
            <CardContent className="p-6">
              <p className="text-sm font-medium text-muted-foreground">Total Present</p>
              <div className="text-3xl font-bold text-chart-1">{data.total_present}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <p className="text-sm font-medium text-muted-foreground">Total Absent</p>
              <div className="text-3xl font-bold text-muted-foreground">{data.total_absent}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <p className="text-sm font-medium text-muted-foreground">Attendance Rate</p>
              <div className="text-3xl font-bold">
                {data.total_students > 0 ? Math.round((data.total_present / data.total_students) * 100) : 0}%
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Attendance Log</CardTitle>
          <CardDescription>
            {data ? `Showing records for ${format(new Date(data.date), "MMMM d, yyyy")}` : "Loading..."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Check In Time</TableHead>
                  <TableHead className="text-right">Points Earned</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center">Loading attendance...</TableCell>
                  </TableRow>
                ) : data?.records?.length ? (
                  data.records.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell>
                        <div className="font-medium">{record.student_name}</div>
                        <div className="text-xs text-muted-foreground">{record.student_id}</div>
                      </TableCell>
                      <TableCell>Grade {record.grade}</TableCell>
                      <TableCell>
                        <Badge variant={record.status === "present" ? "default" : "secondary"} className={record.status === "present" ? "bg-chart-1" : ""}>
                          {record.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {record.check_in_time ? format(new Date(record.check_in_time), "h:mm a") : "-"}
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {record.points_earned > 0 ? `+${record.points_earned}` : "-"}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No records for this date.</TableCell>
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
