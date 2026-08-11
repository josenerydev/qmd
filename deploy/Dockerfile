# qmd-mcp — imagem do qmd (adapter remoto OpenAI-compatible) + entrypoint de
# clone/index/serve. Build a partir da RAIZ do repo:
#   docker build -f deploy/Dockerfile .
# Nota: sem otimização de imagem por ora; node-llama-cpp fica instalado porém
# dormente no caminho remoto (o lazy loader não dispara).
FROM node:22

WORKDIR /app/qmd

COPY package.json package-lock.json* ./
RUN npm install
COPY . ./
RUN npm run build && npm link        # deixa o binário `qmd` no PATH

# yq (mikefarah) — o entrypoint lê o sources.yaml (multi-fonte)
RUN wget -qO /usr/local/bin/yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 \
    && chmod +x /usr/local/bin/yq

COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8181
ENTRYPOINT ["/entrypoint.sh"]
