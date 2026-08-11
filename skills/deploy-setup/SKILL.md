---
name: deploy-setup
description: Guide the user through a local qmd-mcp setup with docker compose — .env (OpenAI-spec provider), sources.yaml (git and local folders), bring-up, health/auth verification and MCP client wiring. Use when the user asks to set up, deploy, run or connect qmd as an MCP server via docker. Self-contained — ships its own compose/env/sources templates, no repo clone required.
license: MIT
compatibility: Requires Docker with the compose plugin. Standalone via the prebuilt image josenerydev/qmd-mcp (templates/ shipped with this skill), or from a clone of the repo (deploy/).
metadata:
  author: josenerydev
  version: "1.1.0"
---

# qmd-mcp — guided docker compose setup

Walk the user through a working local deployment. Ask before assuming; apply the
safety rules at the bottom at all times. This skill is **self-contained**: the
`templates/` folder next to this file has everything needed (standalone compose
using the prebuilt image, env and sources examples) — the repo is NOT required.

> **Installing this skill without cloning the repo** (for the user, one-liner —
> use `.claude/skills` in a project or `~/.claude/skills` for user-wide;
> other agent clients: extract anywhere and point the agent at `SKILL.md`):
>
> ```sh
> mkdir -p ~/.claude/skills/deploy-setup && curl -fsSL https://github.com/josenerydev/qmd/tarball/main \
>   | tar -xz --strip-components=3 -C ~/.claude/skills/deploy-setup --wildcards '*/skills/deploy-setup/*'
> ```

## 1. Pick the layout

- **Standalone** (default — no clone): create a working folder, copy the
  templates shipped with this skill and create the sources mount:
  ```sh
  mkdir -p qmd-mcp/sources && cd qmd-mcp
  cp <this-skill-dir>/templates/docker-compose.yml .
  cp <this-skill-dir>/templates/env.example .env
  cp <this-skill-dir>/templates/sources.example.yaml sources/sources.yaml
  ```
  The compose pulls `josenerydev/qmd-mcp:latest` — nothing is built locally.
- **From the repo** (contributors / building from source): work in `deploy/` of
  https://github.com/josenerydev/qmd — same files, plus `build:` from checkout.

Check prerequisites first: `docker compose version`. If the default port is
busy (`ss -ltn | grep 8181`), plan a different `QMD_MCP_PORT`.

## 2. Configure `.env`

With `.env` in place (copied above), fill in with the user:

| Ask the user | Env vars |
|---|---|
| Which OpenAI-spec provider? (OpenRouter, OpenAI, own gateway…) | `QMD_LLM_BASE_URL` — the adapter appends `/embeddings` and `/rerank` (OpenRouter: `https://openrouter.ai/api/v1`) |
| API key | `QMD_LLM_API_KEY` |
| Embed + rerank models, **in the provider's naming** | `QMD_EMBED_MODEL`, `QMD_RERANK_MODEL` (OpenRouter: `openai/text-embedding-3-small`, `cohere/rerank-4-fast`) |
| Periodic auto-refresh? | `REFRESH_INTERVAL` in seconds; empty = off (refresh stays available on demand via the MCP `refresh` tool) |

Always generate a bearer token instead of leaving `/mcp` open:

```sh
sed -i "s/^QMD_MCP_AUTH_TOKEN=.*/QMD_MCP_AUTH_TOKEN=$(openssl rand -hex 32)/" .env
```

Keep `QMD_LLM_PROVIDER=remote` as-is. Rerank is optional — if the provider has
no `/rerank`, results degrade gracefully to search order; the stack still works.

## 3. Declare the sources

Edit `sources/sources.yaml` (created in step 1) with the user. Each source
becomes a searchable collection:

```yaml
sources:
  - name: docs                          # collection name
    git: https://github.com/<org>/<repo>
    branch: main
    # tokenEnv: MY_TOKEN                # private repo: var name; put MY_TOKEN=... in .env
    # subdir: docs                      # index only this folder (sparse-checkout)
    # mask: "**/*.{md,txt}"             # files to index (default **/*.md)
    context: "What this source is — injected into search results."

  - name: notes                         # LOCAL folder: place it at ./sources/notes
    path: notes                         # (mounted read-only at /sources inside the container)
    context: "Local notes."
```

`context` matters for answer quality — push the user to write a real sentence.

## 4. Bring it up

```sh
docker compose up -d                    # standalone: pulls the prebuilt image
# from the repo's deploy/: docker compose pull && docker compose up -d --no-build
#                     or:  docker compose up -d --build   (build from source)
docker compose logs -f qmd-mcp
```

First boot **blocks** until sources are cloned, indexed and embedded. The
healthcheck allows 120s; for large corpora tell the user to watch the logs and
expect `(healthy)` to take longer.

## 5. Verify

```sh
curl http://localhost:8181/health                        # {"status":"ok",...} — no auth needed
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8181/mcp   # must be 401
```

A 401 on the second call proves the bearer gate is on. If the server logged
`AVISO: QMD_MCP_AUTH_TOKEN não definido`, stop and fix `.env` — `/mcp` is open.

## 6. Wire the MCP client

```sh
claude mcp add --transport http qmd http://localhost:8181/mcp \
  --header "Authorization: Bearer <token from .env>"
```

Declarative alternative (Claude Code `.mcp.json`; Cursor `~/.cursor/mcp.json`
uses the same shape without `"type"`):

```json
{
  "mcpServers": {
    "qmd": {
      "type": "http",
      "url": "http://localhost:8181/mcp",
      "headers": { "Authorization": "Bearer <token from .env>" }
    }
  }
}
```

Then smoke-test a search through the client (`search`/`query` tools). After the
user pushes new docs to a source, call the `refresh` tool instead of restarting.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Container never healthy, logs stuck on embed | Wrong `QMD_LLM_API_KEY` / model names for that provider — check the first embed error in logs |
| `401` even with the header | Token in the client differs from `.env`; recreate the container after editing `.env` (`docker compose up -d`) |
| `AVISO: falha ao clonar '<name>'` | Bad repo URL, or missing/expired token; private repos need `tokenEnv` + the var in `.env` |
| Local folder skipped | Folder is not under `./sources/`; `path:` is relative to that mount |
| Port already in use | Set `QMD_MCP_PORT` in `.env` (compose maps and healthchecks it consistently) |
| Index stale after pushing docs | Call the MCP `refresh` tool, or set `REFRESH_INTERVAL` |

## Safety rules

- Never print, echo or commit secrets: `.env`, tokens, keys. `deploy/.gitignore`
  already excludes `.env*` and `sources/sources.yaml*` — do not weaken it.
- Never leave `QMD_MCP_AUTH_TOKEN` empty on a setup you finish.
- Keep the port bound to `127.0.0.1` unless the user explicitly asks to expose it.
