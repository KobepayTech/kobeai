# K9 School Server (Windows)

The installable K9 server, packaged the same way as KobeOS: an Electron app
with an NSIS installer that bundles everything a school needs to run K9 on one
Windows PC with no internet.

On launch it:

1. starts an embedded PostgreSQL 18 (bound to `127.0.0.1:5434`, data in the
   user's `%APPDATA%\K9 School Server\pgdata`);
2. applies the `lib/db` schema — new tables and columns only, never drops;
3. runs the KobeAI api-server on port **8088**, which also serves the
   dashboards to the school LAN:

   | Path | Surface |
   |---|---|
   | `/teacher/` | Teacher Dashboard (also the app window) |
   | `/tv/` | Classroom TV |
   | `/lens/` | Teacher Lens |
   | `/parent/` | Parent Portal |

4. keeps running from the system tray when the window is closed.

## First launch

K9 creates one school and one administrator account. The login is shown in a
dialog on first launch and saved to `%APPDATA%\K9 School Server\k9-admin-login.txt`.
Demo accounts are **not** created; set `K9_SEED_DEMO=1` before launching to
load the demo school for evaluation.

The tray / **K9** menu has everything staff need:

- **Copy Classroom TV Link** — open it once on each classroom PC; it pairs the
  TV with this server (the link contains the kiosk key).
- **Copy Teacher Lens Link** / **Copy Parent Portal Link** — for phones on the
  school Wi-Fi.
- **Start K9 When Windows Starts**, data and log folders, quit.

Logs are in `%APPDATA%\K9 School Server\logs` (`main`, `postgres`, `migrate`,
`backend`, `ollama`).

## Local AI

K9 talks to Ollama at `http://127.0.0.1:11434` (for example the one KobeOS
runs). On start — and from **Connect AI Models to Ollama** in the tray menu —
it builds `k9-qwen`, `k9-mistral`, `k9-llama3`, `k9-phi3` and `k9-deepseek`
from the GGUF files in the model registry, reusing blobs Ollama already has, and
the classroom assistant uses the first one available (progress in `models.log`). A build can also bundle an Ollama runtime with `--ollama <folder>`; K9
starts it only if nothing is already listening on port 11434. Models are not
bundled: they live under `C:\KobeOS\Models\k9` as described by
`config/k9-models.json` (shipped with the app and passed to the server as
`K9_MODELS_CONFIG`). The app also starts the K9 model runtime (detection,
tracking, faces, ReID, voice activity) with the Python named in the registry,
and the vision-queue worker that uses it (`runtime.log`, `worker.log`).
Fetch models with `scripts\download-k9-all-ai-except-qwen.cmd`
and check them with `scripts\k9-model-status.cmd` — see `docs/K9_MODEL_STACK.md`.

## Building the installer

On Windows, from the repo root:

```bash
pnpm install
```

```bash
npm --prefix desktop ci
```

```bash
node desktop/scripts/build.mjs
```

Output: `desktop/release/K9-Setup-<version>.exe`. Useful flags:

| Flag | Effect |
|---|---|
| `--dir` | unpacked app only (`desktop/release/win-unpacked`) |
| `--no-package` | build dashboards + server into `desktop/build` and stop |
| `--pack-only` | reuse `desktop/build` and only run electron-builder |
| `--ollama <folder>` | bundle an Ollama runtime folder containing `ollama.exe` |

The build fetches the win32-x64 native packages that the repo's pnpm
overrides strip (rollup, esbuild, lightningcss, Tailwind oxide) into
`node_modules` only, and downloads the Visual C++ runtime from Microsoft if
`build-resources/vc_redist.x64.exe` is missing. CI builds the same installer
with the **K9 Desktop (Windows)** workflow.

Bump `version` in `desktop/package.json` for each release.

## Runtime environment overrides

| Variable | Default | Purpose |
|---|---|---|
| `K9_DATA_DIR` | `%APPDATA%\K9 School Server` | where the database, uploads, secrets and logs live |
| `K9_PORT` | `8088` | LAN port (the installer's firewall rule opens 8088) |
| `K9_PG_PORT` | `5434` | embedded PostgreSQL port |
| `K9_SCHOOL_NAME` | `My School` | school name on first launch |
| `K9_SEED_DEMO` | unset | `1` loads the demo school and demo logins |
| `AI_PROVIDER` / `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | `ollama` / local | AI backend |

## Installer behaviour

- Per-machine install (asks for administrator rights), desktop + Start Menu
  shortcuts, launches K9 when finished.
- Installs the Visual C++ 2015-2022 x64 runtime when missing.
- Adds a Windows Firewall rule for TCP 8088 on private and domain networks,
  and removes it on uninstall. School data in `%APPDATA%` is kept.
- The exe is not code-signed yet, so Windows SmartScreen shows a warning on
  first run.
