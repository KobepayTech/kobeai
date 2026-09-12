import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useGetParentDashboard } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { RenewalBanner } from "@/components/renewal-banner";
import { AdBanner } from "@/components/ad-banner";
import { SchoolDayCard } from "@/components/school-day";
import { Star, TrendingUp, ArrowRight, UserPlus, Package, Newspaper, Sparkles, Trophy } from "lucide-react";

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { token } = useAuth();

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  const { data, isLoading } = useGetParentDashboard({
    request: { headers: { Authorization: `Bearer ${token}` } }
  });

  if (!token) return null;

  return (
    <Layout>
      <div className="px-6 pt-12 pb-6 bg-primary text-white rounded-b-[40px] shadow-sm relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4"></div>
        <div className="relative z-10">
          <h1 className="text-sm font-medium text-primary-foreground/80 mb-1">Good morning,</h1>
          <h2 className="text-3xl font-bold mb-6">{isLoading ? <div className="h-8 w-32 bg-white/20 rounded animate-pulse"></div> : data?.parent_name}</h2>
        </div>
      </div>

      <div className="px-6 -mt-8 relative z-20 space-y-6">
        <RenewalBanner />
        <AdBanner placement="parent_app_home" />
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setLocation("/stationery")}
            data-testid="link-stationery"
            className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-start gap-2 hover:shadow-md transition"
          >
            <div className="w-10 h-10 bg-primary/10 text-primary rounded-xl flex items-center justify-center">
              <Package className="w-5 h-5" />
            </div>
            <p className="text-sm font-bold">Stationery</p>
            <p className="text-xs text-gray-500 -mt-1">Order supplies</p>
          </button>
          <button
            onClick={() => setLocation("/add-child")}
            data-testid="link-add-child"
            className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-start gap-2 hover:shadow-md transition"
          >
            <div className="w-10 h-10 bg-primary/10 text-primary rounded-xl flex items-center justify-center">
              <UserPlus className="w-5 h-5" />
            </div>
            <p className="text-sm font-bold">Add a child</p>
            <p className="text-xs text-gray-500 -mt-1">Claim or scan</p>
          </button>
        </div>
        {isLoading ? (
          <div className="space-y-4">
            <Card className="p-6 rounded-3xl shadow-sm border-none"><div className="h-24 bg-gray-100 animate-pulse rounded-xl"></div></Card>
            <Card className="p-6 rounded-3xl shadow-sm border-none"><div className="h-24 bg-gray-100 animate-pulse rounded-xl"></div></Card>
          </div>
        ) : (
          data?.children?.map((child) => (
            <Card key={child.id} className="p-6 rounded-3xl shadow-sm border-gray-100 hover:shadow-md transition-shadow">
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h3 className="text-xl font-bold text-gray-900">{child.name}</h3>
                  <p className="text-sm text-gray-500">Grade {child.grade}</p>
                </div>
                <div className="bg-primary/10 text-primary px-3 py-1 rounded-full text-xs font-bold tracking-wide">
                  {child.attendance_streak} DAY STREAK
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-gray-50 rounded-2xl p-4">
                  <div className="flex items-center gap-2 text-gray-500 mb-1 text-sm">
                    <Star className="w-4 h-4 text-amber-400" />
                    Today's Points
                  </div>
                  <p className="text-2xl font-bold text-gray-900">+{child.today_points}</p>
                </div>
                <div className="bg-gray-50 rounded-2xl p-4">
                  <div className="flex items-center gap-2 text-gray-500 mb-1 text-sm">
                    <TrendingUp className="w-4 h-4 text-emerald-500" />
                    Total Points
                  </div>
                  <p className="text-2xl font-bold text-gray-900">{child.total_points}</p>
                </div>
              </div>

              <div className="mt-6 flex justify-between items-center bg-gray-50 rounded-2xl p-4">
                <div>
                  <p className="text-sm text-gray-500">Wallet Balance</p>
                  <p className="text-lg font-bold text-gray-900">TSh {child.balance.toLocaleString()}</p>
                </div>
                <button
                  onClick={() => setLocation('/wallet')}
                  className="w-10 h-10 bg-white rounded-full flex items-center justify-center text-primary shadow-sm hover:bg-primary hover:text-white transition-colors"
                >
                  <ArrowRight className="w-5 h-5" />
                </button>
              </div>

              <SchoolDayCard childId={child.id} />

              <button
                onClick={() => setLocation(`/report-card/${child.id}`)}
                className="mt-4 w-full flex items-center justify-between bg-emerald-50 hover:bg-emerald-100 transition rounded-2xl p-4"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center">
                    <Trophy className="w-5 h-5" />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-semibold text-gray-900">Report card</p>
                    <p className="text-xs text-gray-500 -mt-0.5">Scores, grades and class position</p>
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-emerald-700" />
              </button>

              <button
                onClick={() => setLocation(`/magazine/${child.id}`)}
                className="mt-4 w-full flex items-center justify-between bg-primary/5 hover:bg-primary/10 transition rounded-2xl p-4"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
                    <Newspaper className="w-5 h-5" />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-semibold text-gray-900">{child.name}'s week</p>
                    <p className="text-xs text-gray-500 -mt-0.5">Personalised school edition</p>
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-primary" />
              </button>

              <button
                onClick={() => setLocation(`/development/${child.id}`)}
                className="mt-3 w-full flex items-center justify-between bg-amber-50 hover:bg-amber-100 transition rounded-2xl p-4"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-semibold text-gray-900">Notes &amp; lesson plan</p>
                    <p className="text-xs text-gray-500 -mt-0.5">What the AI is learning about {child.name}</p>
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-amber-700" />
              </button>
            </Card>
          ))
        )}
      </div>
    </Layout>
  );
}
