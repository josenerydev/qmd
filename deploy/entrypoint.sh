#!/usr/bin/env bash
# qmd-mcp — indexes N document sources (local + git) → serves MCP (HTTP).
# Sources declared in /sources/sources.yaml (multi-source); without it, falls back
# to single-source mode (QMD_SOURCE_REPO_URL). Blocks on first boot until indexed.
set -uo pipefail

SRC_FILE="/sources/sources.yaml"

# --- build the URL with a token (PAT as user, stripping any existing 'user@') ---
# Azure DevOps: https://<PAT>@dev.azure.com/…; GitHub: https://<token>@github.com/…
auth_url() {
  local url="$1" token="${2:-}"
  [ -z "$token" ] && { echo "$url"; return; }
  local rest="${url#https://}"
  rest="${rest#*@}"
  echo "https://${token}@${rest}"
}

# --- register a source as a collection (idempotent; one failure does not bring it down) ---
# args: name  kind(git|local)  location(url|path)  branch  tokenEnv  context  subdir  mask
# subdir (optional): scopes the source to a subfolder of the repo/folder. For git, downloads
# ONLY the subfolder via sparse-checkout (scoped download); empty = the whole repo.
# mask (optional): glob of the files to index (e.g. '**/*.{md,txt,vtt}'); empty = '**/*.md'.
add_source() {
  local name="$1" kind="$2" loc="$3" branch="${4:-main}" tokenEnv="${5:-}" context="${6:-}" subdir="${7:-}" mask="${8:-}"
  [ -z "$mask" ] && mask="**/*.md"
  local target index_path
  if [ "$kind" = "git" ]; then
    target="/data/${name}"
    if [ ! -d "${target}/.git" ]; then
      local token url
      token=""
      [ -n "$tokenEnv" ] && token="$(printenv "$tokenEnv" 2>/dev/null || true)"
      url="$(auth_url "$loc" "$token")"
      if [ -n "$subdir" ]; then
        echo "[entrypoint] cloning source '${name}' (${branch}, only the '${subdir}' subfolder)..."
        if ! git clone --depth 1 --branch "$branch" --filter=blob:none --sparse "$url" "$target"; then
          echo "[entrypoint] WARNING: failed to clone '${name}' — skipping this source"
          return 0
        fi
        if ! git -C "$target" sparse-checkout set "$subdir"; then
          echo "[entrypoint] WARNING: sparse-checkout of '${subdir}' failed in '${name}' — skipping"
          return 0
        fi
      else
        echo "[entrypoint] cloning source '${name}' (${branch})..."
        if ! git clone --depth 1 --branch "$branch" "$url" "$target"; then
          echo "[entrypoint] WARNING: failed to clone '${name}' — skipping this source"
          return 0
        fi
      fi
    fi
  else
    target="/sources/${loc}"
    if [ ! -d "$target" ]; then
      echo "[entrypoint] WARNING: local folder '${target}' does not exist — skipping '${name}'"
      return 0
    fi
  fi
  index_path="$target"
  [ -n "$subdir" ] && index_path="${target}/${subdir}"
  if [ ! -d "$index_path" ]; then
    echo "[entrypoint] WARNING: subfolder '${subdir}' does not exist in '${name}' — skipping"
    return 0
  fi
  # mask changed on an existing collection? recreate it (add with the same name is a no-op in qmd)
  local current_mask
  current_mask="$(qmd collection show "$name" 2>/dev/null | sed -n 's/^  Pattern:  //p')"
  if [ -n "$current_mask" ] && [ "$current_mask" != "$mask" ]; then
    echo "[entrypoint] mask of '${name}' changed ('${current_mask}' → '${mask}') — recreating collection"
    qmd collection remove "$name" >/dev/null 2>&1 || true
  fi
  qmd collection add "$index_path" --name "$name" --mask "$mask" 2>/dev/null || true
  [ -n "$context" ] && qmd context add "$index_path" "$context" 2>/dev/null || true
  echo "[entrypoint] source '${name}' → collection registered (${index_path}, mask ${mask})"
}

# --- 1. fetch + register the sources -------------------------------------------
if [ -f "$SRC_FILE" ]; then
  n="$(yq '.sources | length' "$SRC_FILE" 2>/dev/null || echo 0)"
  echo "[entrypoint] multi-source: ${n} source(s) in ${SRC_FILE}"
  i=0
  while [ "$i" -lt "$n" ]; do
    name="$(yq ".sources[$i].name" "$SRC_FILE")"
    git="$(yq ".sources[$i].git // \"\"" "$SRC_FILE")"
    path="$(yq ".sources[$i].path // \"\"" "$SRC_FILE")"
    branch="$(yq ".sources[$i].branch // \"main\"" "$SRC_FILE")"
    tokenEnv="$(yq ".sources[$i].tokenEnv // \"\"" "$SRC_FILE")"
    context="$(yq ".sources[$i].context // \"\"" "$SRC_FILE")"
    subdir="$(yq ".sources[$i].subdir // \"\"" "$SRC_FILE")"
    mask="$(yq ".sources[$i].mask // \"\"" "$SRC_FILE")"
    if [ -n "$git" ]; then
      add_source "$name" git "$git" "$branch" "$tokenEnv" "$context" "$subdir" "$mask"
    else
      add_source "$name" local "$path" "" "" "$context" "$subdir" "$mask"
    fi
    i=$((i + 1))
  done
else
  # --- fallback: single source (QMD_SOURCE_REPO_URL), no sources.yaml ---------
  echo "[entrypoint] single source (no ${SRC_FILE})"
  add_source "source" git "${QMD_SOURCE_REPO_URL:-}" "${QMD_SOURCE_REPO_BRANCH:-main}" \
    "QMD_SOURCE_REPO_TOKEN" "${QMD_SOURCE_CONTEXT:-}" \
    "" "${QMD_SOURCE_REPO_MASK:-}"
fi

# --- 2. index (BLOCKS): pull the git repos + reindex + embed -------------------
qmd update --pull || true
qmd embed

# --- 3. optional periodic refresh (in-container cron) -------------------------
# REFRESH_INTERVAL = seconds between refreshes (git pull + reindex + embed) via
# `qmd refresh` — the SAME primitive as the MCP `refresh` tool. A lockfile serializes
# this cron with the tool (agent), so the two never trip over each other.
# Empty/0/non-numeric = OFF: index refreshed only at boot or on demand via the tool.
if [ -n "${REFRESH_INTERVAL:-}" ] && [ "${REFRESH_INTERVAL}" -gt 0 ] 2>/dev/null; then
  echo "[entrypoint] periodic refresh every ${REFRESH_INTERVAL}s"
  (
    while sleep "${REFRESH_INTERVAL}"; do
      echo "[entrypoint] periodic refresh..."
      qmd refresh || echo "[entrypoint] WARNING: periodic refresh failed (staying up)"
    done
  ) &
else
  echo "[entrypoint] periodic refresh disabled (set REFRESH_INTERVAL=<seconds> to enable)"
fi

# --- 4. serve MCP over HTTP ----------------------------------------------------
exec qmd mcp --http --host 0.0.0.0 --port "${QMD_MCP_PORT:-8181}"
