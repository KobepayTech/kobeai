# KobeVoice runtime wiring

KobeAI now exposes an authenticated voice gateway and an OpenAI-compatible Chat Completions bridge for the embedded KobeVoice service.

## Required shared secret

Set the same long random secret on both services:

```text
KobeAI API:   KOBEVOICE_SHARED_SECRET=<same-secret>
KobeVoice:    KOBEAI_VOICE_SECRET=<same-secret>
```

Point KobeVoice at the KobeAI API origin:

```text
KOBEAI_BASE_URL=http://<kobeai-api-host>:<port>
```

When `KOBEAI_BASE_URL` is present, the KobeVoice LiveKit agent routes its LLM stage to:

```text
/api/v1/voice/openai/chat/completions
```

KobeVoice continues to own media transport, STT and TTS. KobeAI owns the answer path and therefore remains the place where PAIR/direct Ollama routing, retrieval, school context, tools and policy are added.

## Native voice gateway

The KobeAI API also exposes:

- `POST /api/v1/voice/session`
- `POST /api/v1/voice/turn`
- `POST /api/v1/voice/tool-result`
- `POST /api/v1/voice/session/:id/end`
- `GET /api/v1/voice/health`

These endpoints accept either a first-party KobeAI JWT or the KobeVoice service credential. The OpenAI-compatible bridge accepts the service credential as a Bearer API key so LiveKit's standard OpenAI-compatible LLM client can use it without a custom plugin.

## Current boundary

The OpenAI bridge is functional but KobeAI's current `askAI()` provider is still non-streaming. The bridge returns valid SSE when `stream=true`, but emits the generated answer in one content chunk after inference completes. True token streaming should be added in Router v2/provider work.

Voice sessions are currently kept in the school API process memory and expire automatically. That matches the existing single-process school-server architecture. If the API is later replicated, move voice-session state and rate-limit buckets to Redis or another shared store.

## Data handling

Raw audio is not sent to or stored by the KobeAI voice gateway. KobeVoice performs STT and sends text to KobeAI. Recording, if enabled for a specific deployment, remains a separate explicitly authorized media-layer concern.
