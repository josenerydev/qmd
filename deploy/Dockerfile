# qmd-mcp — the qmd image (remote OpenAI-compatible adapter) + a clone/index/serve
# entrypoint. Build from the ROOT of the repo:
#   docker build -f deploy/Dockerfile .
# Note: no image-size optimization for now; node-llama-cpp stays installed but
# dormant on the remote path (the lazy loader never fires).
FROM node:22

WORKDIR /app/qmd

COPY package.json package-lock.json* ./
RUN npm install
COPY . ./
RUN npm run build && npm link        # puts the `qmd` binary on PATH

# yq (mikefarah) — the entrypoint reads sources.yaml (multi-source)
RUN wget -qO /usr/local/bin/yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 \
    && chmod +x /usr/local/bin/yq

COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8181
ENTRYPOINT ["/entrypoint.sh"]
