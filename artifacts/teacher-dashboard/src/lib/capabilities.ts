import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

// What the signed-in user is allowed to see. The server decides
// (GET /v1/me/capabilities); the dashboard only draws what it is told.
//
// This is why a school that installs K9 never sees the operator console.
// The pages under /central are KobepayTech's — every school's licence key,
// the KP economy, the market agent's reward band — and a school
// administrator has no business knowing they exist. Hiding them here is the
// courtesy; requireAuth(["super_admin"]) on the server is the enforcement.

export type Capabilities = {
  teaching: boolean;
  bursar: boolean;
  onboarding: boolean;
  school_settings: boolean;
  operator: boolean;
  tenants: boolean;
  market_agent: boolean;
  kp_economy: boolean;
  moderation: boolean;
  central_stationery: boolean;
};

export type CapabilityKey = keyof Capabilities;

export type Me = {
  role: string;
  name: string | null;
  school_name: string | null;
  setup_complete: boolean;
  capabilities: Capabilities;
};

/** Everything off — what an unknown or still-loading user may see. */
const NOTHING: Capabilities = {
  teaching: false,
  bursar: false,
  onboarding: false,
  school_settings: false,
  operator: false,
  tenants: false,
  market_agent: false,
  kp_economy: false,
  moderation: false,
  central_stationery: false,
};

export function useMe() {
  const query = useQuery<Me>({
    queryKey: ["me-capabilities"],
    queryFn: () => apiGet<Me>("/v1/me/capabilities"),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return {
    ...query,
    me: query.data ?? null,
    // Default closed: a failed or in-flight call shows the teaching surface
    // only, never an operator page that would 403 on click.
    can: query.data?.capabilities ?? { ...NOTHING, teaching: query.isLoading },
  };
}
