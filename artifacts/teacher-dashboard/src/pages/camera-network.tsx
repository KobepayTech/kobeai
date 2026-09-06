import { useQuery } from "@tanstack/react-query";
import { Camera, CircleAlert, Network, Radio, Server, ShieldAlert } from "lucide-react";
import { apiGet } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type DiscoverySummary = {
  known_devices: number;
  online: number;
  cameras: number;
  recorders: number;
  new_devices: number;
  flagged: number;
  claimed_cameras: number;
};

type Scan = {
  scanned_at?: string;
  cidr?: string | null;
  devices_seen?: number;
};

type Device = {
  device_key: string;
  ip: string | null;
  mac: string | null;
  hostname: string | null;
  display_name: string | null;
  vendor: string | null;
  device_type: string | null;
  category: string | null;
  flags: string[] | null;
  online: boolean;
  is_new: boolean;
  is_alert: boolean;
  claimed_camera_id: string | null;
};

async function getSummary() {
  return apiGet<{ summary: DiscoverySummary; last_scan: Scan | null }>("/v1/network-discovery/summary");
}

async function getDevices() {
  return apiGet<{ devices: Device[] }>("/v1/network-discovery/devices");
}

function metric(label: string, value: number | undefined, Icon: typeof Camera) {
  return (
    <Card>
      <CardContent className="p-5 flex items-center justify-between gap-4">
        <div>
          <div className="text-2xl font-bold">{value ?? 0}</div>
          <div className="text-sm text-muted-foreground">{label}</div>
        </div>
        <Icon className="h-6 w-6 text-muted-foreground" />
      </CardContent>
    </Card>
  );
}

function deviceName(device: Device): string {
  return device.display_name || device.hostname || device.device_type || device.ip || "Unknown device";
}

export default function CameraNetwork() {
  const summary = useQuery({ queryKey: ["network-discovery-summary"], queryFn: getSummary, refetchInterval: 30_000 });
  const inventory = useQuery({ queryKey: ["network-discovery-devices"], queryFn: getDevices, refetchInterval: 30_000 });

  const devices = inventory.data?.devices ?? [];
  const cameraCandidates = devices.filter((device) => {
    const flags = device.flags ?? [];
    return device.category === "camera" || flags.some((flag) => ["CAMERA", "CAMERA?", "SURVEILLANCE"].includes(flag));
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Camera Network</h1>
        <p className="text-muted-foreground mt-1">
          K-9 discovers the school LAN; KobeVision uses claimed camera streams for live attendance and location evidence.
        </p>
        {summary.data?.last_scan?.scanned_at && (
          <p className="text-xs text-muted-foreground mt-2">
            Last K-9 scan {new Date(summary.data.last_scan.scanned_at).toLocaleString()}
            {summary.data.last_scan.cidr ? ` · ${summary.data.last_scan.cidr}` : ""}
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        {metric("Online devices", summary.data?.summary.online, Network)}
        {metric("Camera candidates", summary.data?.summary.cameras, Camera)}
        {metric("NVR / DVR", summary.data?.summary.recorders, Server)}
        {metric("Claimed cameras", summary.data?.summary.claimed_cameras, Radio)}
        {metric("New devices", summary.data?.summary.new_devices, CircleAlert)}
        {metric("Flagged", summary.data?.summary.flagged, ShieldAlert)}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Discovered camera and recorder candidates</CardTitle>
          <CardDescription>
            Devices are discovered automatically. A network device only becomes attendance evidence after it is claimed, assigned to a campus zone and given a working local RTSP/ONVIF stream.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>Network</TableHead>
                  <TableHead>Vendor / type</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>KobeVision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inventory.isLoading ? (
                  <TableRow><TableCell colSpan={6} className="h-24 text-center">Scanning inventory…</TableCell></TableRow>
                ) : cameraCandidates.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                      No camera/NVR candidates have been synced yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  cameraCandidates.map((device) => (
                    <TableRow key={device.device_key}>
                      <TableCell>
                        <div className="font-medium">{deviceName(device)}</div>
                        <div className="text-xs text-muted-foreground">{device.device_key}</div>
                      </TableCell>
                      <TableCell>
                        <div>{device.ip ?? "—"}</div>
                        <div className="text-xs text-muted-foreground font-mono">{device.mac ?? "—"}</div>
                      </TableCell>
                      <TableCell>
                        <div>{device.vendor ?? "Unknown vendor"}</div>
                        <div className="text-xs text-muted-foreground">{device.device_type ?? device.category ?? "Unknown"}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {(device.flags ?? []).length ? (device.flags ?? []).map((flag) => (
                            <Badge key={flag} variant={flag === "NEW" ? "secondary" : "outline"}>{flag}</Badge>
                          )) : <span className="text-muted-foreground">—</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={device.online ? "default" : "secondary"}>{device.online ? "Online" : "Offline"}</Badge>
                      </TableCell>
                      <TableCell>
                        {device.claimed_camera_id ? (
                          <Badge variant="default">{device.claimed_camera_id}</Badge>
                        ) : (
                          <Badge variant="secondary">Not claimed</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Why K-9 and KobeVision are separate</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 text-sm">
          <div className="rounded-lg border p-4">
            <div className="font-semibold mb-1">K-9 · network truth</div>
            <p className="text-muted-foreground">Finds devices, identifies cameras/NVRs, tracks online/offline state, new devices, exposed services and CCTV-network security changes.</p>
          </div>
          <div className="rounded-lg border p-4">
            <div className="font-semibold mb-1">KobeVision · video truth</div>
            <p className="text-muted-foreground">Opens the claimed live stream, checks frames, detects/recognizes faces and sends student sightings to the timetable-aware presence engine.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
