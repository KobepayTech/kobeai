import { AdapterUnavailableError, type GlassesAdapter, type GlassesDescriptor } from "./GlassesAdapter";
import type { KobeGlasses } from "./KobeGlasses";

// Picks an adapter and opens a pair of glasses. K9 asks for "some glasses" and
// gets whatever is actually present: Brilliant Frame over WebBluetooth on a
// teacher's phone, a Mentra device in the React Native shell, or the simulator
// in tests and on a laptop.

export type DiscoveredGlasses = GlassesDescriptor & { vendor: string };

export class GlassesManager {
  private adapters: GlassesAdapter[] = [];

  register(adapter: GlassesAdapter): this {
    this.adapters.push(adapter);
    return this;
  }

  /** Adapters that can run in this process, in registration order. */
  async availableAdapters(): Promise<GlassesAdapter[]> {
    const checks = await Promise.all(
      this.adapters.map(async (adapter) => ((await adapter.isAvailable().catch(() => false)) ? adapter : null)),
    );
    return checks.filter((adapter): adapter is GlassesAdapter => adapter !== null);
  }

  /** Everything every usable adapter can see. Adapters that throw are skipped. */
  async discover(): Promise<DiscoveredGlasses[]> {
    const found: DiscoveredGlasses[] = [];
    for (const adapter of await this.availableAdapters()) {
      const devices = await adapter.discover().catch(() => []);
      for (const device of devices) found.push({ ...device, vendor: adapter.vendor });
    }
    return found;
  }

  async open(device: DiscoveredGlasses): Promise<KobeGlasses> {
    const adapter = this.adapters.find((candidate) => candidate.vendor === device.vendor);
    if (!adapter) throw new AdapterUnavailableError(device.vendor, "no adapter is registered for it");
    if (!(await adapter.isAvailable())) throw new AdapterUnavailableError(device.vendor, "its adapter can't run here");
    const glasses = await adapter.open(device);
    await glasses.connect();
    return glasses;
  }

  /** Opens the first pair of glasses found. Throws when nothing is connectable. */
  async connectFirst(): Promise<KobeGlasses> {
    const devices = await this.discover();
    const first = devices[0];
    if (!first) {
      const vendors = (await this.availableAdapters()).map((adapter) => adapter.vendor);
      throw new Error(
        vendors.length === 0
          ? "No glasses adapter can run here — on a laptop use the simulator adapter."
          : `No glasses found by: ${vendors.join(", ")}`,
      );
    }
    return this.open(first);
  }
}
