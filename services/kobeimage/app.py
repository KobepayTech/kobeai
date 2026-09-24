import io, os
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

MODEL_ID = os.getenv("KOBE_IMAGE_MODEL", "Qwen/Qwen-Image")
ALLOWED_MODELS = {"Qwen/Qwen-Image"}
if MODEL_ID not in ALLOWED_MODELS:
    raise RuntimeError("KobeImage production only permits explicitly approved commercial models")
app = FastAPI(title="KobeImage", version="1.0.0")
_pipe = None
class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    width: int = Field(default=1024, ge=256, le=2048)
    height: int = Field(default=1024, ge=256, le=2048)
    steps: int = Field(default=30, ge=1, le=80)
    guidance: float = Field(default=4.0, ge=0, le=20)
    seed: int | None = None

def pipeline():
    global _pipe
    if _pipe is None:
        import torch
        from diffusers import DiffusionPipeline
        dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
        _pipe = DiffusionPipeline.from_pretrained(MODEL_ID, torch_dtype=dtype)
        if torch.cuda.is_available(): _pipe.to("cuda")
    return _pipe

@app.get("/health")
def health(): return {"ok": True, "model": MODEL_ID, "license_policy": "commercial-approved-only"}

@app.post("/v1/images/generations")
def generate(req: GenerateRequest):
    try:
        import torch
        generator = None
        if req.seed is not None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
            generator = torch.Generator(device=device).manual_seed(req.seed)
        image = pipeline()(prompt=req.prompt, width=req.width, height=req.height, num_inference_steps=req.steps, true_cfg_scale=req.guidance, generator=generator).images[0]
        out = io.BytesIO(); image.save(out, format="PNG")
        return Response(out.getvalue(), media_type="image/png", headers={"X-KobeAI-Model": MODEL_ID})
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"image generation failed: {exc}") from exc
