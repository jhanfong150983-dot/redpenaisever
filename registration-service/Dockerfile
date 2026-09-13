FROM python:3.12-slim

# opencv-headless 仍需 libglib
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY register_core.py app.py ./

ENV PORT=8010
EXPOSE 8010
# 純 CPU、每請求 <2s；單 worker（SIFT 佔記憶體）、要吞吐用多 replica
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT} --workers 1"]
