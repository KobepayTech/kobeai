import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { Layout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Settings, HelpCircle, FileText, LogOut, ChevronRight, User } from "lucide-react";
import { useGetParentDashboard } from "@workspace/api-client-react";

export default function Profile() {
  const [, setLocation] = useLocation();
  const { token, logout } = useAuth();

  useEffect(() => {
    if (!token) setLocation("/login");
  }, [token, setLocation]);

  const { data } = useGetParentDashboard({
    request: { headers: { Authorization: `Bearer ${token}` } }
  });

  const handleLogout = () => {
    logout();
    setLocation("/login");
  };

  if (!token) return null;

  const menuItems = [
    { icon: Settings, label: "Account Settings", href: "#" },
    { icon: HelpCircle, label: "Help & Support", href: "#" },
    { icon: FileText, label: "Terms & Privacy", href: "#" },
  ];

  return (
    <Layout>
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-8">Profile</h1>

        <div className="flex items-center gap-4 mb-8">
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center text-primary shrink-0">
            <User className="w-8 h-8" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-900">{data?.parent_name || 'Parent'}</h2>
            <p className="text-gray-500 text-sm">Parent Account</p>
          </div>
        </div>

        <Card className="rounded-3xl border-gray-100 shadow-sm overflow-hidden mb-6">
          <div className="divide-y divide-gray-100">
            {menuItems.map((item, i) => (
              <button key={i} className="w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center text-gray-500">
                    <item.icon className="w-5 h-5" />
                  </div>
                  <span className="font-medium text-gray-900">{item.label}</span>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400" />
              </button>
            ))}
          </div>
        </Card>

        <Button 
          onClick={handleLogout}
          variant="destructive" 
          className="w-full h-14 rounded-xl text-base font-semibold shadow-none bg-rose-50 text-rose-600 hover:bg-rose-100 hover:text-rose-700 border-none"
        >
          <LogOut className="w-5 h-5 mr-2" />
          Log Out
        </Button>
      </div>
    </Layout>
  );
}
