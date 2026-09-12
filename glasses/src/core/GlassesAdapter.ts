import type { KobeGlasses } from "./KobeGlasses";

// An adapter knows how to find and open one family of hardware. Adapters are
// registered with the GlassesManager; nothing else imports them directly, so a
// new vendor (or an OEM's own BLE protocol) is one file plus one registration.

export type GlassesDescriptor = {
  /** Stable id for this device as the adapter sees it. */
  id: string;
  model: string;
  vendor: string;
  /** Only set when the adapter already knows, e.g. a remembered pairing. */
  lastSeenAt?: number;
};

export interface GlassesAdapter {
  readonly vendor: string;
  /** False when this adapter can't run here (no WebBluetooth, not React Native, …). */
  isAvailable(): Promise<boolean>;
  /** Devices the adapter can offer right now. May prompt the wearer to pick one. */
  discover(): Promise<GlassesDescriptor[]>;
  open(descriptor: GlassesDescriptor): Promise<KobeGlasses>;
}

/** Why an adapter can't be used here — surfaced to the teacher, not swallowed. */
export class AdapterUnavailableError extends Error {
  constructor(
    public vendor: string,
    reason: string,
  ) {
    super(`${vendor} glasses are not available here: ${reason}`);
    this.name = "AdapterUnavailableError";
  }
}
