# Kobe Glasses SDK

One interface for every pair of glasses K9 supports, so nothing above the
adapter ever branches on hardware:

```text
K9 feature  →  KobeGlasses  →  adapter  →  hardware
```

```ts
await glasses.display.text("Physics starts in Room 4");
controller.say("Your next class is Physics");
```

**Glasses are staff kit.** Teachers, admin and security wear them; no student
does. That follows the K9 surface list (teacher laptop, teacher phone / Teacher
Lens, classroom PC + TV, admin PC, parent phone, cameras, optional AR glasses).

## What is here

| Path | What it is |
|---|---|
| `src/core/` | `KobeGlasses` interface, capabilities, typed events, adapter contract, `GlassesManager` |
| `src/adapters/simulator/` | Software glasses that record what was shown and spoken — what the tests and laptop development run against |
| `src/adapters/brilliant/` | Brilliant Labs Frame / Halo over WebBluetooth, including the Lua the Frame runs |
| `src/adapters/mentra/` | MentraOS devices (Mentra Live, Even Realities, Vuzix Z100, NIMO) |
| `src/k9/` | `K9Api` (the school server's existing lens endpoints) and `K9GlassesController` (lookup, marking, assistant, translate, safety) |
| `tests/` | `node --test` over the simulator and both adapters, no hardware needed |

```cmd
pnpm --filter @workspace/glasses run test
pnpm --filter @workspace/glasses run typecheck
```

## Capabilities, not model names

Hardware varies more than features do, so a feature asks what the glasses have:

```ts
const caps = await glasses.getCapabilities();
if (caps.camera) await glasses.camera.capture();
```

Asking for something the hardware lacks throws `CapabilityMissingError` rather
than failing quietly. Examples: Even G1 has a display and microphone but no
camera; Brilliant Frame has display, camera, microphone and IMU but no speaker;
a camera-only OEM pair has no display at all. No MentraOS or Brilliant model
speaks text on the glasses themselves, so `controller.say()` falls back to the
teacher's phone or earbud — which is also how Teacher Lens whispers work today.

## Vendor reality check

These are the facts the adapters are written against, not assumptions:

- **Mentra** — [`@mentra/bluetooth-sdk`](https://www.npmjs.com/package/@mentra/bluetooth-sdk) (MIT) runs in
  **React Native / Expo only** (Expo ≥ 49, React Native ≥ 0.72; native
  `com.mentraglass:bluetooth-sdk`, `MentraBluetoothSDK`). Its published metadata
  documents scan/connect/reconnect, display text + clear + dashboard, photo and
  video, microphone in LC3 or PCM, typed lifecycle state, and button, touch,
  swipe, battery, Wi-Fi and OTA events — but **not exact method signatures**. So
  `MentraAdapter` takes an injected `MentraClient`: the mobile shell owns the
  SDK binding, and K9 stays on one interface. Confirm the signatures against the
  [starter kit](https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit)
  when wiring the shell.
- **Brilliant** — [`brilliant-ble`](https://www.npmjs.com/package/brilliant-ble) and
  [`brilliant-msg`](https://www.npmjs.com/package/brilliant-msg) (BSD-3-Clause) are
  **browser WebBluetooth**: `BrilliantBle.connect/sendLua/disconnect`,
  `setPrintResponseHandler`, `type` = FRAME | HALO, and `TxSprite` /
  `TxTextPage` / `TxCaptureSettings` / `RxPhoto` / `RxClick`. Because Teacher
  Lens is already a browser PWA, this path works from the teacher's phone with
  no native build. The packages are injected rather than depended on, so this
  workspace installs nothing until the lens actually uses them.
- **xg.glass** — [`hkust-spark/xg-glass-sdk`](https://github.com/hkust-spark/xg-glass-sdk)
  (Apache-2.0) covers Rokid, Meta, Frame, RayNeo, INMO Air3, Omi, Even G1 and a
  simulator, but ships **Kotlin, Swift and a Python CLI — no JavaScript or
  TypeScript binding**. It therefore cannot be a TypeScript adapter here. It
  belongs on the native side of the mobile shell (or behind a small local
  bridge) and would appear to K9 as one more `GlassesAdapter` implemented in
  `mobile/`. Nothing in `src/` pretends otherwise.

## Local-first

Glasses never need a vendor cloud for K9 to work:

```text
glasses  --bluetooth-->  teacher phone / K9 hub  --wifi-->  school K9 server  -->  local models
```

`K9Api` calls the endpoints the school server already has — lens sessions,
frames, whispers, lookup, enroll-face and the classroom assistant — so a frame
from the glasses goes through exactly the same path as one from the Teacher Lens
phone: faces matched by YuNet + SFace against enrolled students, papers read by
the Qwen3-VL brain, answers spoken back as whispers.

## Adding hardware

1. Write an adapter implementing `GlassesAdapter` + `KobeGlasses`.
2. Report honest capabilities.
3. Register it: `manager.register(new MyOemAdapter(...))`.

Nothing in `src/k9/` changes — that is the point of the layer.
