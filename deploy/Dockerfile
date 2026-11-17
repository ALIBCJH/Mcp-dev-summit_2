# One image for the host and all three MCP servers. Each pod picks its job
# with its start command. Build from the project root:
#   docker build -f deploy/Dockerfile -t safiri:demo2 .
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

# Packages first: this layer is rebuilt only when the pins change.
# They come from deploy/wheels (filled by build_image.sh), never from the
# network, so the image can be rebuilt offline and on a slow venue link.
COPY requirements.txt requirements.txt
COPY deploy/requirements-k8s.txt deploy/requirements-k8s.txt
COPY deploy/wheels/ /wheels/
RUN pip install --no-index --find-links /wheels \
        -r requirements.txt -r deploy/requirements-k8s.txt \
    && rm -rf /wheels

COPY host/ host/
COPY web/ web/
COPY servers/ servers/
COPY deploy/gateway/ deploy/gateway/

# No secret and no .env in the image; the API key arrives as a pod env var.
USER 10001
