FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1     PYTHONUNBUFFERED=1     PIP_NO_CACHE_DIR=1     K9_MODELS_CONFIG=/app/config/k9-models.json     K9_MODELS_ROOT=/models/k9     KOBEOS_MODELS_ROOT=/models/base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends       build-essential cmake git curl ffmpeg libsndfile1 libgl1 libglib2.0-0     && rm -rf /var/lib/apt/lists/*
COPY services/k9-runtime/requirements.txt /tmp/requirements.txt
RUN pip install --upgrade pip     && pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu     && grep -Ev '^(torch|torchvision|torchaudio)([<=>].*)?$' /tmp/requirements.txt > /tmp/requirements-no-torch.txt     && pip install -r /tmp/requirements-no-torch.txt
COPY config/k9-models.json /app/config/k9-models.json
COPY services/k9-runtime /app/services/k9-runtime
WORKDIR /app/services/k9-runtime
ENV PYTHONPATH=/app/services/k9-runtime
USER 10001:10001
EXPOSE 8766
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8766/health', timeout=3).read()"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8766"]
