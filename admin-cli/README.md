# KobeAI Admin CLI

Bash CLI for managing a **self-hosted, on-premise KobeAI deployment** — the
school-server scenario where the entire stack (Postgres, Redis, Ollama, the
API, the dashboards, nginx) runs in Docker on a single Linux box and the
school may be fully offline most of the time.

> This CLI does **not** run from inside the Replit workspace — it requires
> Docker on the host machine and is meant for the on-prem server. Save these
> scripts to your school server (or an SD card / USB stick) and run them
> there.

## What's inside

```
admin-cli/
├── kobeai-admin     Main CLI dispatcher
├── models.sh        AI model lifecycle (install/list/status/remove/export/import)
├── system.sh        Docker-compose service control + health/stats/backup
└── install-cli.sh   Installer that puts kobeai-admin on PATH
```

## Prerequisites on the school server

Before this CLI can do anything useful, the host needs:

1. **Docker + docker-compose** installed.
2. **A `docker-compose.yml`** (and optional `.env`) at `/opt/kobeai/` (or
   wherever `KOBEAI_HOME` points) that brings up these containers:
   | Container          | Purpose                          |
   |--------------------|----------------------------------|
   | `kobeai-postgres`  | PostgreSQL 5432                  |
   | `kobeai-redis`     | Redis 6379                       |
   | `kobeai-ollama`    | Ollama LLM server 11434          |
   | `kobeai-backend`   | The Express API on port 8000     |
   | `kobeai-teacher`   | Teacher Dashboard on port 3000   |
   | `kobeai-parent`    | Parent App on port 5173          |
   | `kobeai-nginx`     | Reverse proxy on port 80         |
3. **An Ollama-compatible AI provider** wired into the API server (see
   "Pointing the API at Ollama" below).

The compose file isn't shipped here yet — the recommended next step is to
add `deploy/school-server/docker-compose.yml` with images built from the
existing `artifacts/api-server`, `artifacts/teacher-dashboard`, and
`artifacts/parent-app`. Ask and I'll generate it.

## Installation on the school server

```bash
# Copy this folder to /opt/kobeai/admin-cli on the target machine
sudo mkdir -p /opt/kobeai
sudo cp -r admin-cli /opt/kobeai/
cd /opt/kobeai/admin-cli
sudo bash install-cli.sh
```

The installer copies the scripts to `/opt/kobeai/admin-cli` and drops a
wrapper at `/usr/local/bin/kobeai-admin` so you can run it from anywhere.

## Common commands

```bash
# Bring everything up
kobeai-admin system start

# Full health check (API, Postgres, Redis, Ollama, dashboards, resources)
kobeai-admin health

# Pull all four AI models the first time (~10 GB, needs internet)
kobeai-admin models install

# Or just one
kobeai-admin models install --model mistral:7b

# Show which models are installed
kobeai-admin models status

# Make an offline package of the models for use in a school with no internet
kobeai-admin models export                 # writes ~/kobeai-models-YYYYMMDD.tar.gz

# On the offline school server (USB stick / SD card transfer):
kobeai-admin models import /media/usb/kobeai-models-20260416.tar.gz

# Tell the watches where the API server lives on the school LAN
kobeai-admin server-url http://192.168.1.100:8000

# Backups + logs
kobeai-admin backup
kobeai-admin system logs api
```

## Default model lineup

| Model                  | Purpose                          | Size    |
|------------------------|----------------------------------|---------|
| `mistral:7b`           | Primary tutor (general purpose)  | 4.1 GB  |
| `phi:2.7b`             | Fast fallback for slow hardware  | 1.6 GB  |
| `deepseek-coder:6.7b`  | Math / science / coding          | 3.8 GB  |
| `nomic-embed-text`     | Embeddings for semantic search   | 274 MB  |

## Pointing the API at Ollama

The API server in this repo (`artifacts/api-server`) currently returns
canned responses for `/v1/watch/ask`. To make it call Ollama in an on-prem
deployment, add an env var to the `kobeai-backend` container, e.g.

```env
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://kobeai-ollama:11434
OLLAMA_MODEL=mistral:7b
```

…and update the watch / parent ask endpoints to forward to
`POST {OLLAMA_BASE_URL}/api/generate`. I haven't wired this in yet — say the
word and I'll add an Ollama provider module to the API server gated on
`AI_PROVIDER=ollama` so the same codebase works in both modes (cloud
provider when deployed to Replit, Ollama when deployed on-prem).

## Hardware budget for the school server

Ollama + Mistral 7B at usable speed needs roughly:
- **CPU only:** 16+ GB RAM, 8+ modern cores → ~5–10 sec/response (workable)
- **With GPU:** 8 GB+ VRAM (e.g. RTX 3060) → ~1 sec/response (great)
- **Disk:** 30 GB for all four models + headroom

## Known gaps that need work for a real school deployment

1. No `docker-compose.yml` yet — needs to be authored and tested.
2. The API server doesn't have an Ollama provider yet (uses canned answers).
3. The `/api/v1/admin/stats` endpoint that `kobeai-admin stats` calls
   doesn't exist server-side yet.
4. No image build pipeline — the three artifacts need Dockerfiles before
   docker-compose can build them.

When you're ready to do an actual school pilot, those four are the next
chunks of work.
