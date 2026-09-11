from __future__ import annotations

import gc
import hmac
import io
import logging
import os
import sys
import threading
import wave
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel, Field

from model_registry import BY_NAME, choose_model, default_model_root, statuses

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("k9-runtime")

APP_VERSION = "k9-model-runtime-1"
MODEL_ROOT = default_model_root()
SERVICE_SECRET = os.getenv("K9_RUNTIME_SHARED_SECRET", os.getenv("K9_SHARED_SECRET", "")).strip()
DEVICE = os.getenv("K9_DEVICE", "auto").strip().lower()
GGUF_CONTEXT = int(os.getenv("K9_GGUF_CONTEXT", "8192"))
GGUF_GPU_LAYERS = int(os.getenv("K9_GGUF_GPU_LAYERS", "-1"))

app = FastAPI(title="K9 Model Runtime", version=APP_VERSION)


def require_secret(
    authorization: str | None = Header(default=None),
    x_k9_secret: str | None = Header(default=None),
) -> None:
    if not SERVICE_SECRET:
        raise HTTPException(status_code=503, detail="K9_RUNTIME_SHARED_SECRET is not configured")
    supplied = x_k9_secret or ""
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    if not supplied or not hmac.compare_digest(SERVICE_SECRET, supplied):
        raise HTTPException(status_code=401, detail="invalid K9 runtime credential")


def image_from_bytes(data: bytes) -> Image.Image:
    try:
        return Image.open(io.BytesIO(data)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid_image:{exc}") from exc


def torch_device() -> str:
    if DEVICE != "auto":
        return DEVICE
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def move_inputs(inputs: Any, device: str) -> Any:
    if not hasattr(inputs, "items"):
        return inputs
    for key, value in list(inputs.items()):
        if hasattr(value, "to"):
            inputs[key] = value.to(device)
    return inputs


def first_file(path: Path, patterns: tuple[str, ...]) -> Path:
    if path.is_file():
        return path
    for pattern in patterns:
        matches = sorted(path.rglob(pattern))
        if matches:
            return matches[0]
    raise FileNotFoundError(f"required_model_file_not_found:{path}:{patterns}")


class ModelManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._loaded: dict[str, Any] = {}
        self._errors: dict[str, str] = {}
        self._trackers: dict[str, Any] = {}

    def status(self) -> list[dict]:
        result = []
        with self._lock:
            loaded = set(self._loaded)
            errors = dict(self._errors)
        for item in statuses(MODEL_ROOT):
            item["loaded"] = item["name"] in loaded
            item["error"] = errors.get(item["name"])
            result.append(item)
        return result

    def load(self, name: str) -> Any:
        spec = BY_NAME.get(name)
        if not spec:
            raise KeyError(f"unknown_model:{name}")
        path = spec.path(MODEL_ROOT)
        if not path.exists():
            raise FileNotFoundError(f"model_not_present:{name}:{path}")

        with self._lock:
            if name in self._loaded:
                return self._loaded[name]

        try:
            loaded = self._load_spec(spec.loader, path, name)
        except Exception as exc:
            with self._lock:
                self._errors[name] = f"{type(exc).__name__}: {exc}"
            raise

        with self._lock:
            self._loaded[name] = loaded
            self._errors.pop(name, None)
        logger.info("Loaded K9 model %s from %s", name, path)
        return loaded

    def unload(self, name: str) -> bool:
        with self._lock:
            value = self._loaded.pop(name, None)
            self._errors.pop(name, None)
        if value is None:
            return False
        del value
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        return True

    def tracker(self, camera_id: str) -> Any:
        key = camera_id.strip() or "default"
        with self._lock:
            if key in self._trackers:
                return self._trackers[key]
        tracker_cls = self.load("bytetrack")
        args = SimpleNamespace(track_thresh=0.45, track_buffer=30, match_thresh=0.8, mot20=False)
        tracker = tracker_cls(args, frame_rate=30)
        with self._lock:
            self._trackers[key] = tracker
        return tracker

    def _load_spec(self, loader: str, path: Path, name: str) -> Any:
        if loader == "llama_cpp":
            from llama_cpp import Llama

            return Llama(
                model_path=str(path),
                n_ctx=GGUF_CONTEXT,
                n_gpu_layers=GGUF_GPU_LAYERS if torch_device() == "cuda" else 0,
                verbose=False,
            )

        if loader == "ultralytics":
            from ultralytics import YOLO

            return YOLO(str(path))

        if loader == "transformers_text":
            from transformers import AutoModelForCausalLM, AutoTokenizer

            tokenizer = AutoTokenizer.from_pretrained(str(path), local_files_only=True, trust_remote_code=True)
            kwargs: dict[str, Any] = {"local_files_only": True, "trust_remote_code": True}
            if torch_device() == "cuda":
                kwargs.update({"device_map": "auto", "torch_dtype": "auto"})
            model = AutoModelForCausalLM.from_pretrained(str(path), **kwargs)
            if torch_device() != "cuda":
                model.to(torch_device())
            model.eval()
            return tokenizer, model

        if loader == "transformers_vlm":
            import transformers
            from transformers import AutoProcessor

            processor = AutoProcessor.from_pretrained(str(path), local_files_only=True, trust_remote_code=True)
            candidates = [
                getattr(transformers, "AutoModelForImageTextToText", None),
                getattr(transformers, "AutoModelForVision2Seq", None),
                getattr(transformers, "AutoModelForCausalLM", None),
            ]
            errors: list[str] = []
            for cls in candidates:
                if cls is None:
                    continue
                try:
                    kwargs: dict[str, Any] = {"local_files_only": True, "trust_remote_code": True}
                    if torch_device() == "cuda":
                        kwargs.update({"device_map": "auto", "torch_dtype": "auto"})
                    model = cls.from_pretrained(str(path), **kwargs)
                    if torch_device() != "cuda":
                        model.to(torch_device())
                    model.eval()
                    return processor, model
                except Exception as exc:
                    errors.append(f"{cls.__name__}:{exc}")
            raise RuntimeError("no_transformers_vlm_loader_succeeded:" + " | ".join(errors[-3:]))

        if loader == "transformers_asr":
            from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

            processor = AutoProcessor.from_pretrained(
                str(path), local_files_only=True, trust_remote_code=True
            )
            kwargs: dict[str, Any] = {"local_files_only": True, "trust_remote_code": True}
            if torch_device() == "cuda":
                kwargs.update({"torch_dtype": "auto"})
            model = AutoModelForSpeechSeq2Seq.from_pretrained(str(path), **kwargs)
            model.to(torch_device())
            model.eval()
            device = 0 if torch_device() == "cuda" else -1
            return pipeline(
                "automatic-speech-recognition",
                model=model,
                tokenizer=processor.tokenizer,
                feature_extractor=processor.feature_extractor,
                device=device,
            )

        if loader == "sentence_transformers":
            from sentence_transformers import SentenceTransformer

            return SentenceTransformer(str(path), device=torch_device(), local_files_only=True)

        if loader == "opencv_yunet":
            import cv2

            model = first_file(path, ("*.onnx",))
            return cv2.FaceDetectorYN.create(str(model), "", (320, 320), 0.8, 0.3, 5000)

        if loader == "opencv_sface":
            import cv2

            model = first_file(path, ("*.onnx",))
            return cv2.FaceRecognizerSF.create(str(model), "")

        if loader == "bytetrack":
            repo = path.resolve()
            sys.path.insert(0, str(repo))
            from yolox.tracker.byte_tracker import BYTETracker

            return BYTETracker

        if loader == "osnet":
            code = MODEL_ROOT / "reid" / "deep-person-reid"
            sys.path.insert(0, str(code.resolve()))
            from torchreid.utils import FeatureExtractor

            checkpoint = first_file(path, ("*.pth",))
            return FeatureExtractor(
                model_name="osnet_ain_x1_0",
                model_path=str(checkpoint),
                device=torch_device(),
            )

        if loader == "silero":
            import torch

            model, utils = torch.hub.load(
                repo_or_dir=str(path),
                model="silero_vad",
                source="local",
                trust_repo=True,
            )
            return model, utils

        if loader == "titanet":
            from nemo.collections.asr.models import EncDecSpeakerLabelModel

            nemo_file = first_file(path, ("*.nemo",))
            return EncDecSpeakerLabelModel.restore_from(str(nemo_file), map_location=torch_device())

        if loader == "pyannote":
            from pyannote.audio import Pipeline

            config = first_file(path, ("config.yaml", "*.yaml"))
            return Pipeline.from_pretrained(str(config))

        if loader == "piper":
            from piper.voice import PiperVoice

            model = first_file(path, ("*.onnx",))
            config_candidates = sorted(path.rglob("*.onnx.json"))
            config = config_candidates[0] if config_candidates else Path(str(model) + ".json")
            return PiperVoice.load(str(model), config_path=str(config))

        if loader in {"python_plugin", "paddle_component", "kokoro", "transformers_detection"}:
            return path

        raise RuntimeError(f"unsupported_loader:{loader}:{name}")


manager = ModelManager()


class LoadRequest(BaseModel):
    model: str


class ChatRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=32_000)
    model: str | None = None
    max_new_tokens: int = Field(default=512, ge=1, le=4096)
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=128)
    model: str | None = None


class TrackDetection(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float = Field(ge=0.0, le=1.0)


class TrackRequest(BaseModel):
    camera_id: str = "default"
    detections: list[TrackDetection]
    frame_width: int = Field(gt=0)
    frame_height: int = Field(gt=0)


@app.get("/health")
def health() -> dict:
    model_status = manager.status()
    present = sum(1 for item in model_status if item["present"])
    loaded = sum(1 for item in model_status if item["loaded"])
    errors = [item["name"] for item in model_status if item["error"]]
    return {
        "ok": True,
        "version": APP_VERSION,
        "model_root": str(MODEL_ROOT),
        "device": torch_device(),
        "present": present,
        "loaded": loaded,
        "errors": errors,
    }


@app.get("/v1/models", dependencies=[Depends(require_secret)])
def list_models() -> dict:
    return {"root": str(MODEL_ROOT), "models": manager.status()}


@app.post("/v1/models/load", dependencies=[Depends(require_secret)])
def load_model(request: LoadRequest) -> dict:
    try:
        manager.load(request.model)
    except (KeyError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"model_load_failed:{request.model}:{exc}") from exc
    return {"ok": True, "model": request.model, "loaded": True}


@app.post("/v1/models/unload", dependencies=[Depends(require_secret)])
def unload_model(request: LoadRequest) -> dict:
    return {"ok": True, "model": request.model, "unloaded": manager.unload(request.model)}


def run_text_model(model_name: str, prompt: str, max_new_tokens: int, temperature: float) -> str:
    spec = BY_NAME[model_name]
    loaded = manager.load(model_name)
    if spec.loader == "llama_cpp":
        output = loaded.create_chat_completion(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_new_tokens,
            temperature=temperature,
        )
        return str(output["choices"][0]["message"]["content"])

    if spec.loader == "transformers_text":
        import torch

        tokenizer, model = loaded
        if hasattr(tokenizer, "apply_chat_template"):
            text = tokenizer.apply_chat_template(
                [{"role": "user", "content": prompt}],
                tokenize=False,
                add_generation_prompt=True,
            )
        else:
            text = prompt
        inputs = tokenizer(text, return_tensors="pt")
        device = next(model.parameters()).device
        inputs = move_inputs(inputs, str(device))
        with torch.inference_mode():
            generated = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=temperature > 0,
                temperature=max(temperature, 1e-5),
            )
        new_tokens = generated[0][inputs["input_ids"].shape[-1] :]
        return tokenizer.decode(new_tokens, skip_special_tokens=True)

    raise RuntimeError(f"model_not_text_capable:{model_name}")


@app.post("/v1/chat", dependencies=[Depends(require_secret)])
def chat(request: ChatRequest) -> dict:
    try:
        spec = choose_model("chat", MODEL_ROOT, request.model)
        answer = run_text_model(spec.name, request.prompt, request.max_new_tokens, request.temperature)
        return {"model": spec.name, "text": answer}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"chat_failed:{exc}") from exc


def run_vlm(model_name: str, image: Image.Image, prompt: str, max_new_tokens: int = 512) -> str:
    import torch

    processor, model = manager.load(model_name)
    text = prompt
    if hasattr(processor, "apply_chat_template"):
        try:
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "image": image},
                        {"type": "text", "text": prompt},
                    ],
                }
            ]
            text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        except Exception:
            text = prompt

    try:
        inputs = processor(text=[text], images=[image], padding=True, return_tensors="pt")
    except TypeError:
        inputs = processor(images=image, text=prompt, return_tensors="pt")
    device = next(model.parameters()).device
    inputs = move_inputs(inputs, str(device))
    with torch.inference_mode():
        generated = model.generate(**inputs, max_new_tokens=max_new_tokens)
    input_len = inputs["input_ids"].shape[-1] if "input_ids" in inputs else 0
    tokens = generated[0][input_len:] if input_len else generated[0]
    return processor.decode(tokens, skip_special_tokens=True)


@app.post("/v1/vision/describe", dependencies=[Depends(require_secret)])
async def describe_image(
    image: UploadFile = File(...),
    prompt: str = Form("Describe what is happening in this school camera frame."),
    model: str | None = Form(default=None),
) -> dict:
    picture = image_from_bytes(await image.read())
    try:
        spec = choose_model("vision", MODEL_ROOT, model)
        text = run_vlm(spec.name, picture, prompt)
        return {"model": spec.name, "text": text}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"vision_failed:{exc}") from exc


@app.post("/v1/ocr", dependencies=[Depends(require_secret)])
async def ocr_image(
    image: UploadFile = File(...),
    model: str | None = Form(default=None),
) -> dict:
    picture = image_from_bytes(await image.read())
    try:
        spec = choose_model("ocr", MODEL_ROOT, model)
        text = run_vlm(
            spec.name,
            picture,
            "Read all visible text exactly. Preserve line breaks and do not add commentary.",
            1024,
        )
        return {"model": spec.name, "text": text}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"ocr_failed:{exc}") from exc


def yolo_result(result: Any, include_keypoints: bool = False) -> dict:
    payload: dict[str, Any] = {"boxes": []}
    boxes = getattr(result, "boxes", None)
    if boxes is not None:
        xyxy = boxes.xyxy.detach().cpu().numpy()
        conf = boxes.conf.detach().cpu().numpy()
        cls = boxes.cls.detach().cpu().numpy()
        names = getattr(result, "names", {})
        for coords, score, class_id in zip(xyxy, conf, cls):
            cid = int(class_id)
            payload["boxes"].append(
                {
                    "xyxy": [float(v) for v in coords.tolist()],
                    "confidence": float(score),
                    "class_id": cid,
                    "class_name": names.get(cid, str(cid)) if isinstance(names, dict) else str(cid),
                }
            )
    if include_keypoints:
        keypoints = getattr(result, "keypoints", None)
        if keypoints is not None and getattr(keypoints, "data", None) is not None:
            payload["keypoints"] = keypoints.data.detach().cpu().numpy().tolist()
    return payload


@app.post("/v1/vision/detect", dependencies=[Depends(require_secret)])
async def detect(
    image: UploadFile = File(...),
    model: str | None = Form(default=None),
    confidence: float = Form(default=0.25),
) -> dict:
    picture = image_from_bytes(await image.read())
    try:
        spec = choose_model("detection", MODEL_ROOT, model)
        if spec.loader != "ultralytics":
            raise RuntimeError(f"detection_adapter_not_ready:{spec.name}")
        detector = manager.load(spec.name)
        result = detector.predict(picture, conf=confidence, verbose=False)[0]
        return {"model": spec.name, **yolo_result(result)}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"detection_failed:{exc}") from exc


@app.post("/v1/vision/pose", dependencies=[Depends(require_secret)])
async def pose(
    image: UploadFile = File(...),
    model: str | None = Form(default=None),
    confidence: float = Form(default=0.25),
) -> dict:
    picture = image_from_bytes(await image.read())
    try:
        spec = choose_model("pose", MODEL_ROOT, model)
        estimator = manager.load(spec.name)
        result = estimator.predict(picture, conf=confidence, verbose=False)[0]
        return {"model": spec.name, **yolo_result(result, include_keypoints=True)}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"pose_failed:{exc}") from exc


@app.post("/v1/tracking/update", dependencies=[Depends(require_secret)])
def tracking_update(request: TrackRequest) -> dict:
    try:
        tracker = manager.tracker(request.camera_id)
        detections = np.asarray(
            [[d.x1, d.y1, d.x2, d.y2, d.confidence] for d in request.detections],
            dtype=np.float32,
        )
        tracks = tracker.update(
            detections,
            [request.frame_height, request.frame_width],
            [request.frame_height, request.frame_width],
        )
        return {
            "camera_id": request.camera_id,
            "tracks": [
                {
                    "track_id": int(track.track_id),
                    "tlwh": [float(v) for v in track.tlwh],
                    "score": float(getattr(track, "score", 0.0)),
                }
                for track in tracks
            ],
        }
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"tracking_failed:{exc}") from exc


@app.post("/v1/reid/embedding", dependencies=[Depends(require_secret)])
async def reid_embedding(image: UploadFile = File(...)) -> dict:
    picture = image_from_bytes(await image.read())
    try:
        extractor = manager.load("osnet-ain")
        embedding = extractor([picture])
        if hasattr(embedding, "detach"):
            embedding = embedding.detach().cpu().numpy()
        vector = np.asarray(embedding)[0].astype(float).tolist()
        return {"model": "osnet-ain", "embedding": vector}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"reid_failed:{exc}") from exc


@app.post("/v1/audio/transcribe", dependencies=[Depends(require_secret)])
async def transcribe(audio: UploadFile = File(...), model: str | None = Form(default=None)) -> dict:
    data = await audio.read()
    try:
        import soundfile as sf

        samples, sample_rate = sf.read(io.BytesIO(data), dtype="float32")
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        spec = choose_model("asr", MODEL_ROOT, model)
        pipeline = manager.load(spec.name)
        result = pipeline({"array": samples, "sampling_rate": int(sample_rate)})
        return {"model": spec.name, "text": result.get("text", ""), "raw": result}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"transcription_failed:{exc}") from exc


@app.post("/v1/audio/vad", dependencies=[Depends(require_secret)])
async def vad(audio: UploadFile = File(...)) -> dict:
    data = await audio.read()
    try:
        import soundfile as sf
        import torch

        samples, sample_rate = sf.read(io.BytesIO(data), dtype="float32")
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        model, utils = manager.load("silero-vad")
        get_speech_timestamps = utils[0]
        tensor = torch.from_numpy(samples)
        speech = get_speech_timestamps(tensor, model, sampling_rate=int(sample_rate), return_seconds=True)
        return {"model": "silero-vad", "speech": speech}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"vad_failed:{exc}") from exc


@app.post("/v1/embed", dependencies=[Depends(require_secret)])
def embed(request: EmbedRequest) -> dict:
    try:
        spec = choose_model("embedding", MODEL_ROOT, request.model)
        model = manager.load(spec.name)
        vectors = model.encode(request.texts, normalize_embeddings=True)
        return {"model": spec.name, "embeddings": np.asarray(vectors).tolist()}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"embedding_failed:{exc}") from exc


@app.post("/v1/tts/swahili", dependencies=[Depends(require_secret)])
def tts_swahili(text: str = Form(...)) -> Response:
    if not text.strip():
        raise HTTPException(status_code=400, detail="text_required")
    try:
        voice = manager.load("piper-swahili")
        target = io.BytesIO()
        with wave.open(target, "wb") as wav_file:
            voice.synthesize_wav(text, wav_file)
        return Response(content=target.getvalue(), media_type="audio/wav")
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"tts_failed:{exc}") from exc
