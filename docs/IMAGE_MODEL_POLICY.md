# KobeAI image-model policy

Production image generation must use models reviewed for commercial deployment. Current production allowlist: Qwen/Qwen-Image (Apache-2.0 upstream).

Qwen-Image-2.1 is research/evaluation only unless Kobetech obtains a separate commercial license from Qwen. It must not be placed behind a paid KobeAI subscription merely by advertising image generation as a free add-on. Do not route production traffic to it, package its weights with paid KobeAI distributions, or use it as an automatic fallback.

Research environments using 2.1 should be operationally separated from production endpoints. If commercial rights are later obtained, update this policy and the services/kobeimage/app.py allowlist in a reviewed change.
