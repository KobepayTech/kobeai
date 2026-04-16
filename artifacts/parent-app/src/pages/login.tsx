import { useState } from "react";
import { useLocation } from "wouter";
import { useParentLogin } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Heart } from "lucide-react";

export default function Login() {
  const [phone, setPhone] = useState("0712345678");
  const [pin, setPin] = useState("1234");
  const [, setLocation] = useLocation();
  const { setToken } = useAuth();
  const { toast } = useToast();

  const loginMutation = useParentLogin();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loginMutation.mutate({ data: { phone, pin } }, {
      onSuccess: (data) => {
        setToken(data.access_token);
        setLocation("/dashboard");
        toast({
          title: "Welcome back!",
          description: `Hello, ${data.parent_name}`,
        });
      },
      onError: () => {
        toast({
          title: "Login failed",
          description: "Please check your phone number and PIN.",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <div className="min-h-[100dvh] w-full max-w-md mx-auto bg-white flex flex-col items-center justify-center p-8 sm:rounded-3xl sm:h-[850px] sm:my-8 sm:min-h-0 sm:border sm:shadow-xl">
      <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-8">
        <Heart className="w-8 h-8 text-primary" />
      </div>
      <h1 className="text-3xl font-bold text-gray-900 mb-2">KobeAI Parent</h1>
      <p className="text-gray-500 mb-8 text-center">Stay connected with your child's learning journey.</p>

      <form onSubmit={handleSubmit} className="w-full space-y-6">
        <div className="space-y-2">
          <Label htmlFor="phone" className="text-gray-700">Phone Number</Label>
          <Input 
            id="phone" 
            type="tel" 
            placeholder="e.g., 0712345678" 
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="h-12 rounded-xl bg-gray-50 border-transparent focus:bg-white focus:border-primary focus:ring-primary"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="pin" className="text-gray-700">4-Digit PIN</Label>
          <Input 
            id="pin" 
            type="password" 
            maxLength={4}
            placeholder="••••" 
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className="h-12 rounded-xl bg-gray-50 border-transparent focus:bg-white focus:border-primary focus:ring-primary text-center tracking-widest text-lg"
            required
          />
        </div>

        <Button 
          type="submit" 
          className="w-full h-12 rounded-xl text-base font-medium shadow-lg shadow-primary/25"
          disabled={loginMutation.isPending}
        >
          {loginMutation.isPending ? "Logging in..." : "Log in"}
        </Button>
      </form>
    </div>
  );
}
