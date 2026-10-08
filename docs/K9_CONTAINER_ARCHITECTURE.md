# K9 container architecture

K9 is now designed as a portable service stack.

## Control plane

k9-api owns authentication, school data, dashboards, devices, learning
profiles, classroom events and orchestration.

## AI plane

k9-runtime owns local model loading and inference for Qwen/DeepSeek and other
GGUF models, vision/OCR, detection/tracking, face/ReID, speech/VAD/speaker
identification, embeddings and local TTS.

Model files remain outside the image so software upgrades do not require
re-downloading large model collections.

## State

PostgreSQL is the persistent relational store and Redis is the queue/cache
layer. This deployment does not introduce Supabase.

## Device flow

glasses/cameras/tablet -> k9-api -> k9-runtime -> k9-api -> classroom UI

The runtime is never intended to be a public Internet endpoint.

## Scaling rule

Scale k9-api horizontally first. Scale k9-runtime according to GPU/CPU
capacity and keep the model store local to the inference node.

For 500 schools, each school can have its own local K9 runtime while a central
control plane handles licensed school metadata, updates and synchronization.

## Security

- Runtime requires K9_RUNTIME_SHARED_SECRET for inference/model endpoints.
- Model volumes are mounted read-only.
- Database credentials come from environment/secrets.
- Never expose port 8766 directly to the public Internet.
