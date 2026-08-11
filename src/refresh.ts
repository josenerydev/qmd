/**
 * refreshSources — atualização sob demanda do índice servido, sem restart.
 *
 * Executa, de forma idempotente e sobre as fontes JÁ configuradas:
 *   1. git pull --ff-only por collection git (isola falha por fonte)
 *   2. store.update() — varre o fs e reconcilia por hash
 *   3. store.embed()  — gera vetores só do que falta (provider remoto neste deploy)
 *
 * Compartilhado por dois gatilhos: a tool MCP `refresh` (agente) e o subcomando
 * `qmd refresh` (cron). Um mutex (in-process + lockfile) impede refreshes sobrepostos.
 *
 * Guard de escopo: opera SOMENTE sobre as collections existentes; `collections`
 * apenas FILTRA essa lista — nunca aceita URL/caminho de fonte não configurada.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { QMDStore } from "./index.js";

export type CollectionRefresh = {
  collection: string;
  kind: "git" | "local";
  /** git pull rodou e teve sucesso (fast-forward). Sempre false para fontes locais. */
  pulled: boolean;
  /** motivo, quando o pull da fonte falhou (isolado — não derruba as demais). */
  pullError?: string;
};

export type RefreshSummary = {
  status: "ok" | "already_running";
  collections: CollectionRefresh[];
  indexed: number;
  updated: number;
  removed: number;
  /** chunks embedados nesta passada. */
  embedded: number;
  durationMs: number;
};

/** Diretório de cache do qmd (mesma convenção do mcp.pid) — abriga o lockfile. */
function cacheDir(): string {
  return process.env.XDG_CACHE_HOME
    ? resolve(process.env.XDG_CACHE_HOME, "qmd")
    : resolve(homedir(), ".cache", "qmd");
}

/** Um refresh nunca deve levar tanto; um lock mais velho que isto é considerado órfão. */
const LOCK_STALE_MS = 60 * 60 * 1000; // 1h

/** Trava in-process (mesmo processo: agente + agente, ou agente + cron in-process). */
let inProcessLock = false;

/**
 * Trava cross-process (tool no server × `qmd refresh` do cron, processos distintos).
 * Criação atômica via flag "wx"; um lock órfão (crash) é sobrescrito por staleness.
 * Best-effort: se não der para gravar o lockfile, não bloqueia o refresh.
 */
function acquireFileLock(): boolean {
  const dir = cacheDir();
  const lockPath = join(dir, "refresh.lock");
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignora */ }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, String(Date.now()), { flag: "wx" });
      return true;
    } catch {
      // já existe — checa staleness
      try {
        const ts = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
        if (!Number.isNaN(ts) && Date.now() - ts < LOCK_STALE_MS) return false; // lock vivo
        unlinkSync(lockPath); // órfão → remove e tenta de novo
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseFileLock(): void {
  try { unlinkSync(join(cacheDir(), "refresh.lock")); } catch { /* ignora */ }
}

/** Roda um git curto e resolve com {code, stdout, stderr}; nunca rejeita. */
function runGit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const proc = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("error", (e) => res({ code: 1, stdout: out, stderr: e.message }));
    proc.on("close", (code) => res({ code: code ?? 1, stdout: out, stderr: err }));
  });
}

/**
 * A collection é git? Detecta via `rev-parse --is-inside-work-tree` a partir do
 * `pwd`. Funciona mesmo com `subdir`/sparse-checkout (o `.git` fica no root do
 * clone, um ancestral do pwd — `existsSync(pwd/.git)` falharia).
 */
async function isInsideGitWorkTree(pwd: string): Promise<boolean> {
  if (!existsSync(pwd)) return false;
  const r = await runGit(["-C", pwd, "rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

/**
 * git pull --ff-only a partir do pwd da collection. O git localiza o root do
 * work tree sozinho (cobre subdir), reutiliza o `origin` do clone (que já carrega
 * o PAT) e preserva o sparse-checkout. --ff-only isola divergência sem merge.
 */
async function gitPull(pwd: string): Promise<{ ok: boolean; error?: string }> {
  const r = await runGit(["-C", pwd, "pull", "--ff-only"]);
  if (r.code === 0) return { ok: true };
  return { ok: false, error: (r.stderr || r.stdout).trim() || `git saiu com código ${r.code}` };
}

/**
 * Atualiza as fontes configuradas (pull + reindex + embed). Ver doc do módulo.
 *
 * @param options.collections filtra as collections existentes (guard: só filtra).
 * @param options.log         sink opcional de progresso (o entrypoint/CLI loga).
 */
export async function refreshSources(
  store: QMDStore,
  options: { collections?: string[]; log?: (msg: string) => void } = {},
): Promise<RefreshSummary> {
  const started = Date.now();
  const log = options.log ?? (() => { /* noop */ });
  const empty = (status: RefreshSummary["status"]): RefreshSummary => ({
    status, collections: [], indexed: 0, updated: 0, removed: 0, embedded: 0, durationMs: Date.now() - started,
  });

  // Mutex: in-process barato + lockfile cross-process. Um refresh em curso →
  // retorna already_running em vez de rodar concorrente ou empilhar.
  if (inProcessLock || !acquireFileLock()) return empty("already_running");
  inProcessLock = true;
  try {
    // Guard de escopo: parte SEMPRE das collections existentes; o filtro só reduz.
    const all = await store.listCollections();
    const filter = options.collections?.filter((n) => n.length > 0);
    const selected = filter && filter.length > 0
      ? all.filter((c) => filter.includes(c.name))
      : all;

    // 1. pull por collection git (falha isolada); locais não puxam, só reindexam.
    const perCollection: CollectionRefresh[] = [];
    for (const col of selected) {
      if (!(await isInsideGitWorkTree(col.pwd))) {
        perCollection.push({ collection: col.name, kind: "local", pulled: false });
        log(`[refresh] ${col.name}: local (sem pull)`);
        continue;
      }
      const res = await gitPull(col.pwd);
      perCollection.push({ collection: col.name, kind: "git", pulled: res.ok, pullError: res.ok ? undefined : res.error });
      log(res.ok ? `[refresh] ${col.name}: git pull ok` : `[refresh] ${col.name}: git pull FALHOU — ${res.error}`);
    }

    // 2. reindex (varredura do fs), escopado às collections selecionadas.
    const selectedNames = selected.map((c) => c.name);
    const upd = await store.update(selectedNames.length > 0 ? { collections: selectedNames } : {});

    // 3. embed só o que falta (idempotente; provider remoto neste deploy).
    const emb = await store.embed();

    log(`[refresh] indexados=${upd.indexed} atualizados=${upd.updated} removidos=${upd.removed} embedados=${emb.chunksEmbedded}`);
    return {
      status: "ok",
      collections: perCollection,
      indexed: upd.indexed,
      updated: upd.updated,
      removed: upd.removed,
      embedded: emb.chunksEmbedded,
      durationMs: Date.now() - started,
    };
  } finally {
    inProcessLock = false;
    releaseFileLock();
  }
}

/** Resumo legível de um RefreshSummary (compartilhado por tool e CLI). */
export function formatRefreshSummary(s: RefreshSummary): string {
  if (s.status === "already_running") return "refresh já em curso — ignorado";
  const secs = Math.round(s.durationMs / 1000);
  const head = `refresh: ${s.indexed} novos, ${s.updated} atualizados, ${s.removed} removidos, ${s.embedded} embedados (${secs}s)`;
  if (s.collections.length === 0) return `${head}\n  (nenhuma fonte)`;
  const lines = s.collections.map((c) => {
    if (c.kind === "local") return `  ${c.collection}: local (reindex)`;
    return c.pulled ? `  ${c.collection}: pull ok` : `  ${c.collection}: pull FALHOU (${c.pullError ?? "?"})`;
  });
  return `${head}\n${lines.join("\n")}`;
}
