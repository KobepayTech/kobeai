# KobeAI School Server — On-Prem Deployment

Everything you need to bring KobeAI up on a single Linux box at a school,
even with no internet after the first boot.

## What's in this folder

```
deploy/school-server/
├── install.sh             # One-shot bootstrap (run this on a fresh server)
├── docker-compose.yml     # The whole stack
├── Dockerfile.api         # Multi-stage build for the Express API
├── Dockerfile.web         # Generic SPA build (teacher-dashboard or parent-app)
├── nginx/default.conf     # Front-door reverse proxy
├── .env.example           # Template — install.sh fills it in
└── README.md              # You are here
```

## Quick start (5 minutes)

On a fresh Ubuntu / Debian box with Docker installed:

```bash
git clone https://github.com/your-org/kobeai.git
cd kobeai
sudo bash deploy/school-server/install.sh
```

That's it. The installer:

1. Verifies Docker + compose are present.
2. Creates `/opt/kobeai/` (data volumes, backups, admin CLI, env).
3. Generates a strong `SESSION_SECRET` and detects the LAN IP.
4. Builds all images and starts every container.
5. Pulls the four AI models (Mistral 7B, Phi 2.7B, DeepSeek-Coder 6.7B,
   nomic-embed-text — about 10 GB).
6. Prints the URLs to share with parents and teachers.

When it's done, parents go to `http://<server-ip>/` and teachers go to
`http://<server-ip>/teacher/`. Watches get configured with
`kobeai-admin server-url http://<server-ip>/api`.

## Installer flags

```bash
sudo bash install.sh --skip-models     # don't download AI models now
sudo bash install.sh --skip-build      # use existing images, just start them
```

## Migrating to a new server

The whole installation is two things: this repo + the contents of
`/opt/kobeai/`. To move to a different machine:

```bash
# On the old server
sudo kobeai-admin backup                                # snapshots DB + config
sudo kobeai-admin models export                         # tarball of LLMs
sudo tar czf /tmp/kobeai-state.tar.gz -C /opt kobeai    # everything else

# Copy /tmp/kobeai-state.tar.gz and ~/kobeai-models-*.tar.gz to the new server
# (USB stick, scp, whatever — these are big files)

# On the new server
git clone <repo> && cd kobeai
sudo bash deploy/school-server/install.sh --skip-models
sudo systemctl stop docker      # not really needed but cleaner
sudo tar xzf /tmp/kobeai-state.tar.gz -C /opt
sudo systemctl start docker
sudo kobeai-admin models import /path/to/kobeai-models-*.tar.gz
sudo kobeai-admin system restart
```

## Service layout

| Container          | Image                        | Host Port | Purpose                |
|--------------------|------------------------------|-----------|------------------------|
| `kobeai-postgres`  | postgres:16-alpine           | 5432      | App DB                 |
| `kobeai-redis`     | redis:7-alpine               | 6379      | Cache / device presence|
| `kobeai-ollama`    | ollama/ollama:latest         | 11434     | Local LLMs             |
| `kobeai-backend`   | built from `Dockerfile.api`  | 8000      | Express API            |
| `kobeai-teacher`   | built from `Dockerfile.web`  | 3000      | Teacher dashboard      |
| `kobeai-parent`    | built from `Dockerfile.web`  | 5173      | Parent app             |
| `kobeai-nginx`     | nginx:1.27-alpine            | 80        | Reverse proxy          |

All data lives under `/opt/kobeai/data/{postgres,redis,ollama}`. Back this
up and you've backed up the whole school's data.

## URLs once running

| User         | URL                                  |
|--------------|--------------------------------------|
| Parents      | `http://<server-ip>/`                |
| Teachers     | `http://<server-ip>/teacher/`        |
| Watch app    | `http://<server-ip>/api` (set via `kobeai-admin server-url`) |
| Admin debug  | `http://<server-ip>:11434` (Ollama)  |

## Hardware budget

Mistral 7B usable speed needs roughly:

- **CPU only:** 16+ GB RAM, 8+ modern cores → ~5–10 sec / answer (workable)
- **With GPU:** 8 GB VRAM (RTX 3060 or similar) → ~1 sec / answer (great)
- **Disk:** 30 GB for all four models + headroom

To enable the GPU, uncomment the `deploy.resources` block on the `ollama`
service in `docker-compose.yml` and install the NVIDIA Container Toolkit on
the host first.

## Daily operations

After install, every operation goes through `kobeai-admin`:

```bash
sudo kobeai-admin health           # full system health
sudo kobeai-admin system status    # which services are up
sudo kobeai-admin system logs api  # tail logs
sudo kobeai-admin models status    # which models are ready
sudo kobeai-admin backup           # snapshot DB + config
sudo kobeai-admin server-url http://192.168.1.100   # update watch URL
```

See `admin-cli/README.md` for the full command list.

## What still needs work

The compose file and Dockerfiles are real and will build, but a few product
gaps remain before this is a polished pilot:

1. **AI provider wiring.** The API currently ignores `AI_PROVIDER`; it
   returns canned answers. Wiring `/api/v1/watch/ask` and the parent chat
   to call Ollama at `${OLLAMA_BASE_URL}/api/generate` is the next step.
2. **`/api/v1/admin/stats` endpoint.** `kobeai-admin stats` will print
   `(API stats not available)` until this exists.
3. **Database migrations on first boot.** The compose stack starts Postgres
   but doesn't run schema migrations yet. Add a `kobeai-migrate` one-shot
   service or run `pnpm --filter @workspace/db db:push` from the backend
   container as a startup hook.
4. **TLS.** nginx serves HTTP only. For internet-exposed deployments, drop
   in a Let's Encrypt sidecar (e.g. caddy as a replacement) or add SSL
   certs to `nginx/default.conf`.
