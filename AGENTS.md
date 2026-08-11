# AGENTS.md

qmd — local search engine for markdown knowledge bases (BM25 + vectors + rerank),
servable as an MCP endpoint. This fork adds a remote OpenAI-spec LLM provider,
MCP bearer auth, `get_raw` and `refresh` tools, and a docker compose deployment
under `deploy/`. See `CLAUDE.md` for development conventions (build, tests,
things you must NOT run automatically).

## Skills

Reusable agent instructions live in `skills/<name>/SKILL.md` (Agent Skills
format — YAML frontmatter + markdown body). Load the relevant one before acting:

- `skills/deploy-setup/` — guide the user through a local qmd-mcp setup with
  docker compose: `.env` (any OpenAI-spec provider), `sources.yaml` (git +
  local folders), bring-up, health/auth checks, MCP client wiring. Use for
  "set up / run / deploy qmd as an MCP server".
- `skills/qmd/` — how to search with qmd well (search → get → answer citing
  sources). Use when answering questions from indexed collections.
- `skills/release/` — release process (changelog validation, hooks, versioning).
  Only on explicit `/release`-style requests.

## Quick facts

- Deploy docs: `deploy/README.md`. Env reference: `deploy/.env.example`.
- Prebuilt image: `josenerydev/qmd-mcp` on Docker Hub (`latest`, `2.6.3-fork.1`).
- Never commit `.env` or `sources/sources.yaml` (gitignored — keep it that way).
- Upstream is `tobi/qmd`; this fork tracks it and layers the remote/MCP additions.
