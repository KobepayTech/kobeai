// Kobe Glasses SDK — one interface for every pair of glasses K9 supports.
//
//   K9 → KobeGlasses → adapter → hardware
//
// Adapters today: simulator (everywhere), Brilliant Frame/Halo (WebBluetooth),
// MentraOS devices (React Native shell supplies the client).

export * from "./core/index";
export { SimulatorAdapter, SimulatorGlasses, type SimulatorOptions } from "./adapters/simulator/SimulatorAdapter";
export { BrilliantAdapter, BrilliantGlasses, type BrilliantBleLike, type BrilliantOptions } from "./adapters/brilliant/BrilliantAdapter";
export { MentraAdapter, MentraGlasses, type MentraClient, type MentraAdapterOptions } from "./adapters/mentra/MentraAdapter";
export * from "./k9/index";
