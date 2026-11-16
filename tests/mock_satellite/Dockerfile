# syntax=docker/dockerfile:1
# Mock ESPHome voice satellite (pulsar on Yandex Station Lite 2) for bridge tests.
#
# The container is an ESPHome *device*: it serves the plaintext Native API on
# 6053 and the HTTP run control on 8099. It needs no Home Assistant and no
# addon; the bridge connects to it instead of to a real column.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# aioesphomeapi provides the protobuf classes and framing the bridge uses;
# aiohttp serves the control API and downloads the TTS answers.
RUN pip install --no-cache-dir "aioesphomeapi>=46,<47" "aiohttp>=3.13,<4"

COPY . /app

# Fixtures are committed; regenerate any that are missing or stale.
RUN python make_fixtures.py

EXPOSE 6053 8099
VOLUME ["/data"]

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
    CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8099/health', timeout=2).status == 200 else 1)"

# The service stays up between runs; a test triggers one with
# POST http://127.0.0.1:8099/start (see README). Add --auto-start to the
# command to run the WAV immediately after the bridge subscribes instead.
CMD ["python", "run.py", \
     "--host", "0.0.0.0", \
     "--port", "6053", \
     "--control-host", "0.0.0.0", \
     "--control-port", "8099", \
     "--wav", "fixtures/wake-run.wav", \
     "--followup-wav", "fixtures/followup.wav", \
     "--out", "/data/tts.wav", \
     "--events-json", "/data/events.json", \
     "--tts-timeout", "30", \
     "--turn-timeout", "60"]
