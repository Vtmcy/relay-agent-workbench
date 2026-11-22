FROM node:24-bookworm-slim

ARG CODEX_VERSION=0.171.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash bubblewrap ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund "@openai/codex@${CODEX_VERSION}" \
    && codex --version \
    && install -d -m 0700 -o node -g node /data

WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
USER node
ENV WORKBENCH_BIND=0.0.0.0 WORKBENCH_PORT=4177 WORKBENCH_DATA_DIR=/data
EXPOSE 4177
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.mjs"]
