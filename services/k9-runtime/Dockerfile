FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    K9_MODEL_ROOT=/models/k9

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential git libgl1 libglib2.0-0 libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir -U pip \
    && python -m pip install --no-cache-dir -r /app/requirements.txt

COPY model_registry.py app.py /app/

EXPOSE 8091
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8091"]
