FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends iproute2 iputils-ping nmap \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/k9-network /k9
COPY services/k9-bridge/sync.py /app/sync.py

ENV K9_ROOT=/k9
ENV K9_HOME=/data
VOLUME ["/data"]

CMD ["python3", "/app/sync.py"]
