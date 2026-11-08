# K9 Kubernetes deployment

K9 now has a Docker-first deployment boundary. Docker Compose is the normal
single-school starting point; Kubernetes is the scale-out layer for
multi-classroom or multi-school infrastructure.

## Services

- k9-api: stateless K9 API/control plane.
- k9-runtime: local AI/vision/audio runtime.
- postgres: persistent relational state.
- redis: queues/cache.

Model weights are not baked into container images. Mount the K9 model store at
/models/k9 and the KobeOS model store at /models/base.

## Scaling

Scale k9-api horizontally first. Scale k9-runtime according to GPU/CPU
capacity and keep the model store local to the inference node.

For a large rollout, each school can keep its own local K9 runtime while a
central control plane handles licensed school metadata, software updates and
synchronization.

## Security

- Runtime inference endpoints require K9_RUNTIME_SHARED_SECRET.
- Model volumes are mounted read-only.
- Kubernetes secrets in all.yaml are placeholders.
- Never expose port 8766 directly to the public Internet.

## Deployment

1. Build and push kobeai-k9-api and kobeai-k9-runtime.
2. Replace the placeholder secrets.
3. Provide storage for the model PVCs.
4. Apply all.yaml.
5. For GPU nodes, add the NVIDIA device plugin and GPU resource request to
   the k9-runtime deployment.
