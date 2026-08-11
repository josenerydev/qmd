# qmd-mcp — deploy via docker compose

Single-service stack: builds the qmd image **from this repo** and serves MCP over HTTP, with vectors and reranking done remotely against **any OpenAI-spec provider** (no local GGUF inference, no GPU needed).

A prebuilt image is published at **[hub.docker.com/r/josenerydev/qmd-mcp](https://hub.docker.com/r/josenerydev/qmd-mcp)** (`josenerydev/qmd-mcp:latest`, immutable tag `2.6.3-fork.1`). The compose file references it: to skip the local build entirely, run `docker compose pull && docker compose up -d --no-build`.

## Prerequisites

- Docker with the compose plugin
- An API key for any OpenAI-compatible endpoint (OpenAI, OpenRouter, your own gateway…)

## 1. Configure the environment

```sh
cd deploy
cp .env.example .env
```

Fill in `.env`:

| Variable | What it is |
|---|---|
| `QMD_LLM_PROVIDER` | `remote` (openai-spec adapter; `openrouter` is a legacy alias) |
| `QMD_LLM_BASE_URL` | Provider base URL — the adapter appends `/embeddings` and `/rerank` (e.g. `https://openrouter.ai/api/v1`) |
| `QMD_LLM_API_KEY` | Provider API key |
| `QMD_EMBED_MODEL` / `QMD_RERANK_MODEL` | Model names in your provider's format |
| `QMD_MCP_AUTH_TOKEN` | Bearer token required on `/mcp` — **leave empty and the endpoint is OPEN** (the server logs a warning) |
| `QMD_MCP_PORT` | MCP port (default 8181, published on localhost only) |
| `REFRESH_INTERVAL` | Optional: seconds between automatic refreshes (pull + reindex + embed); empty = off |

> Want a gateway (LiteLLM, etc.) in front of the provider? That's external to this stack — just point `QMD_LLM_BASE_URL` at it.

## 2. Declare the sources

```sh
cp sources/sources.example.yaml sources/sources.yaml
```

Each source becomes a qmd collection: git repos (cloned on first boot; private ones via `tokenEnv` pointing at a var in `.env`) or local folders under `./sources/`. Optional per source: `subdir` (sparse-checkout of one folder), `mask` (glob of files to index, default `**/*.md`), `context` (description injected into search results).

Without a `sources.yaml`, the entrypoint falls back to a single git source from `QMD_SOURCE_REPO_URL` (see `.env.example`).

## 3. Up

```sh
docker compose up -d          # builds the image on first run
docker compose logs -f qmd-mcp
```

First boot blocks until sources are cloned, indexed and embedded (healthcheck allows 120s; large corpora take longer — follow the logs). Data (clones + index + vectors) lives in the named volume `qmd-data`; full reset with `docker compose down -v`.

## 4. Verify and connect

```sh
curl http://localhost:8181/health
curl -H "Authorization: Bearer $QMD_MCP_AUTH_TOKEN" http://localhost:8181/mcp   # 401 without the token
```

## 5. MCP client setup

Point any MCP client at `http://localhost:8181/mcp` (streamable HTTP) with the bearer token.

**Claude Code** — CLI:

```sh
claude mcp add --transport http qmd http://localhost:8181/mcp \
  --header "Authorization: Bearer <QMD_MCP_AUTH_TOKEN>"
```

…or declaratively, in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "qmd": {
      "type": "http",
      "url": "http://localhost:8181/mcp",
      "headers": {
        "Authorization": "Bearer <QMD_MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`) and other clients that speak streamable HTTP use the same shape:

```json
{
  "mcpServers": {
    "qmd": {
      "url": "http://localhost:8181/mcp",
      "headers": {
        "Authorization": "Bearer <QMD_MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

Available MCP tools include `search`/`query`/`get` from upstream plus this fork's `get_raw` (raw file bytes) and `refresh` (pull + reindex + embed on demand — use it after pushing new docs to a source).
