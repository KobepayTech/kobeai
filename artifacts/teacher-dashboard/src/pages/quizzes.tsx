import { useGetQuizzes } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BookOpen, Clock, Target } from "lucide-react";

export default function Quizzes() {
  const { data, isLoading } = useGetQuizzes();

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Quizzes</h1>
        <p className="text-muted-foreground mt-1">Manage and assign quizzes to student watches.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {isLoading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="flex flex-col">
              <CardHeader><Skeleton className="h-6 w-2/3" /><Skeleton className="h-4 w-1/3" /></CardHeader>
              <CardContent className="flex-1"><Skeleton className="h-20 w-full" /></CardContent>
              <CardFooter><Skeleton className="h-10 w-full" /></CardFooter>
            </Card>
          ))
        ) : data?.quizzes?.length ? (
          data.quizzes.map((quiz) => (
            <Card key={quiz.id} className="flex flex-col hover:border-primary/50 transition-colors">
              <CardHeader>
                <div className="flex justify-between items-start">
                  <Badge variant="outline" className="mb-2 bg-secondary">{quiz.subject}</Badge>
                </div>
                <CardTitle className="line-clamp-2 leading-tight">{quiz.title}</CardTitle>
                <CardDescription>ID: {quiz.id.substring(0, 8)}...</CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <BookOpen className="h-4 w-4" />
                    <span>{quiz.questions_count} Questions</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    <span>{quiz.duration_minutes} Mins</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground col-span-2">
                    <Target className="h-4 w-4" />
                    <span>{quiz.points_possible} Points Possible</span>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="pt-4 border-t">
                <Button className="w-full" variant="outline">View Details</Button>
              </CardFooter>
            </Card>
          ))
        ) : (
          <div className="col-span-full py-12 text-center text-muted-foreground">
            No quizzes available at the moment.
          </div>
        )}
      </div>
    </div>
  );
}
