import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useGetParentDashboard, useGetChildActivity } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Activity as ActivityIcon, BookOpen, CheckCircle, Award } from "lucide-react";

export default function Activity() {
  const [, setLocation] = useLocation();
  const { token } = useAuth();

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  const { data: dashboard, isLoading: isLoadingDashboard } = useGetParentDashboard({
    request: { headers: { Authorization: `Bearer ${token}` } }
  });

  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);

  useEffect(() => {
    if (dashboard?.children?.length && !selectedChildId) {
      setSelectedChildId(dashboard.children[0].id);
    }
  }, [dashboard, selectedChildId]);

  const { data: activityData, isLoading: isLoadingActivity } = useGetChildActivity(
    selectedChildId || "",
    {
      query: { enabled: !!selectedChildId && !!token },
      request: { headers: { Authorization: `Bearer ${token}` } }
    }
  );

  if (!token) return null;

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'quiz': return <BookOpen className="w-5 h-5 text-blue-500" />;
      case 'attendance': return <CheckCircle className="w-5 h-5 text-emerald-500" />;
      case 'achievement': return <Award className="w-5 h-5 text-amber-500" />;
      default: return <ActivityIcon className="w-5 h-5 text-gray-500" />;
    }
  };

  const getActivityColor = (type: string) => {
    switch (type) {
      case 'quiz': return "bg-blue-50";
      case 'attendance': return "bg-emerald-50";
      case 'achievement': return "bg-amber-50";
      default: return "bg-gray-50";
    }
  };

  return (
    <Layout>
      <div className="px-6 py-8 bg-white sticky top-0 z-30 border-b border-gray-100">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Activity Feed</h1>
        
        {!isLoadingDashboard && dashboard?.children && dashboard.children.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
            {dashboard.children.map(child => (
              <button
                key={child.id}
                onClick={() => setSelectedChildId(child.id)}
                className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                  selectedChildId === child.id 
                    ? "bg-primary text-white shadow-md shadow-primary/20" 
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {child.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="p-6 space-y-6">
        {isLoadingActivity || isLoadingDashboard ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => (
              <Card key={i} className="p-4 rounded-2xl border-none shadow-sm h-24 bg-gray-100 animate-pulse"></Card>
            ))}
          </div>
        ) : activityData?.activities?.length === 0 ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <ActivityIcon className="w-8 h-8 text-gray-300" />
            </div>
            <h3 className="text-lg font-medium text-gray-900">No activity yet</h3>
            <p className="text-gray-500">Activities will appear here when they happen.</p>
          </div>
        ) : (
          <div className="space-y-4 relative before:absolute before:inset-0 before:ml-6 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-gray-200 before:to-transparent">
            {activityData?.activities?.map((item) => (
              <div key={item.id} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                <div className={`flex items-center justify-center w-12 h-12 rounded-full border-4 border-white ${getActivityColor(item.type)} shrink-0 z-10 shadow-sm relative left-0`}>
                  {getActivityIcon(item.type)}
                </div>
                
                <Card className="w-[calc(100%-4rem)] ml-4 p-4 rounded-2xl shadow-sm border-gray-100 hover:border-primary/20 transition-colors">
                  <div className="flex justify-between items-start mb-1">
                    <h4 className="font-semibold text-gray-900">{item.subject || 'Activity'}</h4>
                    <span className="text-xs text-gray-400 font-medium">{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <p className="text-sm text-gray-600 mb-3">{item.description}</p>
                  
                  {item.points > 0 && (
                    <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-50 text-amber-600 text-xs font-bold">
                      <Award className="w-3 h-3" />
                      +{item.points} Points
                    </div>
                  )}
                </Card>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
