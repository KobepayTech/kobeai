# KobeImage

Production image generation for KobeAI. The production allowlist currently contains Qwen/Qwen-Image, whose upstream model card identifies it as Apache-2.0 licensed.

## License boundary

Do not configure Qwen-Image-2.1 in this service. Qwen-Image-2.1 uses the Qwen Research License dated 2026-09-20 and requires a separate commercial license for commercial use. Keep 2.1 in a separate research/evaluation environment; it is deliberately absent from ALLOWED_MODELS.

KobeAI subscriptions may include this endpoint without a separate image charge. The compliance boundary comes from the production model license, not from calling image generation free.

Run: pip install -r requirements.txt, then uvicorn app:app --host 0.0.0.0 --port 8770.

POST /v1/images/generations with prompt and optional width, height, steps, guidance, and seed. Response is PNG.
