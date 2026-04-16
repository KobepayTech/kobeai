import { useGetTeacherDashboardStats, useGetLeaderboard } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Users, Target, Activity, Clock, Trophy } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetTeacherDashboardStats();
  const { data: leaderboard, isLoading: leaderboardLoading } = useGetLeaderboard();

  // Mock data for chart if not provided by backend
  const mockChartData = [
    { name: "Mon", points: 400 },
    { name: "Tue", points: 300 },
    { name: "Wed", points: 550 },
    { name: "Thu", points: 450 },
    { name: "Fri", points: 600 },
    { name: "Sat", points: 700 },
    { name: "Sun", points: 850 },
  ];

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
        <p className="text-muted-foreground mt-1">Monitor student engagement and platform activity.</p>
      </div>

      {statsLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map(i => (
            <Card key={i}><CardContent className="p-6"><Skeleton className="h-20 w-full" /></CardContent></Card>
          ))}
        </div>
      ) : stats ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardContent className="p-6 flex flex-col justify-center">
              <div className="flex items-center justify-between space-y-0 pb-2">
                <p className="text-sm font-medium text-muted-foreground">Total Students</p>
                <Users className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="text-3xl font-bold">{stats.total_students}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {stats.active_today} active today
              </p>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-6 flex flex-col justify-center">
              <div className="flex items-center justify-between space-y-0 pb-2">
                <p className="text-sm font-medium text-muted-foreground">Total Points</p>
                <Target className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="text-3xl font-bold">{stats.total_points.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Avg {stats.avg_performance}% performance
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6 flex flex-col justify-center">
              <div className="flex items-center justify-between space-y-0 pb-2">
                <p className="text-sm font-medium text-muted-foreground">Questions Asked</p>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="text-3xl font-bold">{stats.questions_today}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Today across all watches
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6 flex flex-col justify-center">
              <div className="flex items-center justify-between space-y-0 pb-2">
                <p className="text-sm font-medium text-muted-foreground">Online Watches</p>
                <Clock className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="text-3xl font-bold text-chart-2">{stats.online_watches}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Currently connected
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="grid gap-6 md:grid-cols-7">
        <Card className="md:col-span-4 lg:col-span-5">
          <CardHeader>
            <CardTitle>Activity Trend</CardTitle>
            <CardDescription>Points earned over the last 7 days</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={mockChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorPoints" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: "hsl(var(--muted-foreground))", fontSize: 12}} dy={10} />
                  <YAxis axisLine={false} tickLine={false} tick={{fill: "hsl(var(--muted-foreground))", fontSize: 12}} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: "8px" }}
                    itemStyle={{ color: "hsl(var(--foreground))" }}
                  />
                  <Area type="monotone" dataKey="points" stroke="hsl(var(--primary))" strokeWidth={3} fillOpacity={1} fill="url(#colorPoints)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-3 lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trophy className="h-5 w-5 text-chart-4" />
              Leaderboard
            </CardTitle>
            <CardDescription>Top students this week</CardDescription>
          </CardHeader>
          <CardContent>
            {leaderboardLoading ? (
              <div className="space-y-4">
                {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : leaderboard?.entries?.length ? (
              <div className="space-y-4">
                {leaderboard.entries.slice(0, 5).map((entry) => (
                  <div key={entry.student_id} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-sm font-bold">
                        {entry.rank}
                      </div>
                      <div>
                        <p className="text-sm font-medium leading-none">{entry.name}</p>
                        <p className="text-xs text-muted-foreground">Grade {entry.grade}</p>
                      </div>
                    </div>
                    <div className="text-sm font-bold">{entry.points.toLocaleString()} pts</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground text-center py-8">No leaderboard data</div>
            )}
          </CardContent>
        </Card>
      </div>
      
      {stats?.recent_activity && stats.recent_activity.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest actions from students</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {stats.recent_activity.map((activity) => (
                <div key={activity.id} className="flex items-center justify-between border-b border-border/50 pb-4 last:border-0 last:pb-0">
                  <div>
                    <p className="text-sm font-medium">{activity.student_name}</p>
                    <p className="text-sm text-muted-foreground">{activity.action}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-chart-1">+{activity.points} pts</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(activity.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
