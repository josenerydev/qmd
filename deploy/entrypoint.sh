#!/usr/bin/env bash
# qmd-mcp — indexa N fontes de documentos (local + git) → serve MCP (HTTP).
# Fontes declaradas em /sources/sources.yaml (multi-fonte); sem ele, cai no modo
# fonte única (QMD_SOURCE_REPO_URL). Bloqueia na 1ª subida até indexar.
set -uo pipefail

SRC_FILE="/sources/sources.yaml"

# --- monta a URL com token (PAT como user, removendo qualquer 'user@' existente) ---
# Azure DevOps: https://<PAT>@dev.azure.com/…; GitHub: https://<token>@github.com/…
auth_url() {
  local url="$1" token="${2:-}"
  [ -z "$token" ] && { echo "$url"; return; }
  local rest="${url#https://}"
  rest="${rest#*@}"
  echo "https://${token}@${rest}"
}

# --- adiciona uma fonte como collection (idempotente; falha isolada não derruba) ---
# args: name  kind(git|local)  location(url|path)  branch  tokenEnv  context  subdir  mask
# subdir (opcional): escopa a fonte a uma subpasta do repo/pasta. Para git, baixa SÓ a
# subpasta via sparse-checkout (download escopado); vazio = repo inteiro.
# mask (opcional): glob dos arquivos indexados (ex.: '**/*.{md,txt,vtt}'); vazio = '**/*.md'.
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
        echo "[entrypoint] clonando fonte '${name}' (${branch}, só a subpasta '${subdir}')..."
        if ! git clone --depth 1 --branch "$branch" --filter=blob:none --sparse "$url" "$target"; then
          echo "[entrypoint] AVISO: falha ao clonar '${name}' — pulando esta fonte"
          return 0
        fi
        if ! git -C "$target" sparse-checkout set "$subdir"; then
          echo "[entrypoint] AVISO: sparse-checkout de '${subdir}' falhou em '${name}' — pulando"
          return 0
        fi
      else
        echo "[entrypoint] clonando fonte '${name}' (${branch})..."
        if ! git clone --depth 1 --branch "$branch" "$url" "$target"; then
          echo "[entrypoint] AVISO: falha ao clonar '${name}' — pulando esta fonte"
          return 0
        fi
      fi
    fi
  else
    target="/sources/${loc}"
    if [ ! -d "$target" ]; then
      echo "[entrypoint] AVISO: pasta local '${target}' não existe — pulando '${name}'"
      return 0
    fi
  fi
  index_path="$target"
  [ -n "$subdir" ] && index_path="${target}/${subdir}"
  if [ ! -d "$index_path" ]; then
    echo "[entrypoint] AVISO: subpasta '${subdir}' não existe em '${name}' — pulando"
    return 0
  fi
  # mask mudou numa collection existente? recria (add com mesmo nome é no-op no qmd)
  local current_mask
  current_mask="$(qmd collection show "$name" 2>/dev/null | sed -n 's/^  Pattern:  //p')"
  if [ -n "$current_mask" ] && [ "$current_mask" != "$mask" ]; then
    echo "[entrypoint] mask de '${name}' mudou ('${current_mask}' → '${mask}') — recriando collection"
    qmd collection remove "$name" >/dev/null 2>&1 || true
  fi
  qmd collection add "$index_path" --name "$name" --mask "$mask" 2>/dev/null || true
  [ -n "$context" ] && qmd context add "$index_path" "$context" 2>/dev/null || true
  echo "[entrypoint] fonte '${name}' → collection registrada (${index_path}, mask ${mask})"
}

# --- 1. obter + registrar as fontes -------------------------------------------
if [ -f "$SRC_FILE" ]; then
  n="$(yq '.sources | length' "$SRC_FILE" 2>/dev/null || echo 0)"
  echo "[entrypoint] multi-fonte: ${n} fonte(s) em ${SRC_FILE}"
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
  # --- fallback: fonte única (QMD_SOURCE_REPO_URL), sem sources.yaml ----------
  echo "[entrypoint] fonte única (sem ${SRC_FILE})"
  add_source "source" git "${QMD_SOURCE_REPO_URL:-}" "${QMD_SOURCE_REPO_BRANCH:-main}" \
    "QMD_SOURCE_REPO_TOKEN" "${QMD_SOURCE_CONTEXT:-}" \
    "" "${QMD_SOURCE_REPO_MASK:-}"
fi

# --- 2. indexar (BLOQUEIA): pull dos repos git + reindex + embed --------------
qmd update --pull || true
qmd embed

# --- 3. refresh periódico opcional (cron in-container) ------------------------
# REFRESH_INTERVAL = segundos entre refreshes (git pull + reindex + embed) via
# `qmd refresh` — a MESMA primitiva da tool MCP `refresh`. Um lockfile serializa
# este cron com a tool (agente), então os dois não se atropelam.
# Vazio/0/não-numérico = DESLIGADO: índice fresco só no boot ou sob demanda pela tool.
if [ -n "${REFRESH_INTERVAL:-}" ] && [ "${REFRESH_INTERVAL}" -gt 0 ] 2>/dev/null; then
  echo "[entrypoint] refresh periódico a cada ${REFRESH_INTERVAL}s"
  (
    while sleep "${REFRESH_INTERVAL}"; do
      echo "[entrypoint] refresh periódico..."
      qmd refresh || echo "[entrypoint] AVISO: refresh periódico falhou (segue no ar)"
    done
  ) &
else
  echo "[entrypoint] refresh periódico desligado (defina REFRESH_INTERVAL=<segundos> para ligar)"
fi

# --- 4. serve o MCP sobre HTTP ------------------------------------------------
exec qmd mcp --http --host 0.0.0.0 --port "${QMD_MCP_PORT:-8181}"
