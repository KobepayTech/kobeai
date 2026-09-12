// What a pair of glasses can actually do. Every adapter reports this, and K9
// features check it instead of testing for a model name: hardware varies far
// more than the features do (display-only, camera-only, full Android, …).

export type GlassesCapabilities = {
  display: boolean;
  displayColor: boolean;
  displayImage: boolean;
  camera: boolean;
  cameraStream: boolean;
  microphone: boolean;
  speaker: boolean;
  /** The device can turn text into speech itself; otherwise K9 sends audio. */
  speechSynthesis: boolean;
  imu: boolean;
  touch: boolean;
  buttons: boolean;
  wifi: boolean;
  battery: boolean;
};

export const NO_CAPABILITIES: GlassesCapabilities = {
  display: false,
  displayColor: false,
  displayImage: false,
  camera: false,
  cameraStream: false,
  microphone: false,
  speaker: false,
  speechSynthesis: false,
  imu: false,
  touch: false,
  buttons: false,
  wifi: false,
  battery: false,
};

export function capabilities(overrides: Partial<GlassesCapabilities>): GlassesCapabilities {
  return { ...NO_CAPABILITIES, ...overrides };
}

/** Thrown when a feature is asked of hardware that doesn't have it. */
export class CapabilityMissingError extends Error {
  constructor(
    public capability: keyof GlassesCapabilities,
    public model: string,
  ) {
    super(`${model} has no ${capability}`);
    this.name = "CapabilityMissingError";
  }
}

export function requireCapability(
  caps: GlassesCapabilities,
  capability: keyof GlassesCapabilities,
  model: string,
): void {
  if (!caps[capability]) throw new CapabilityMissingError(capability, model);
}
