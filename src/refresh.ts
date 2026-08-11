/**
 * refreshSources — on-demand refresh of the served index, without a restart.
 *
 * Runs idempotently, over the sources that are ALREADY configured:
 *   1. git pull --ff-only per git collection (isolates a per-source failure)
 *   2. store.update() — walks the fs and reconciles by hash
 *   3. store.embed()  — embeds only what is missing (remote provider in this deploy)
 *
 * Shared by two triggers: the MCP `refresh` tool (agent) and the `qmd refresh`
 * subcommand (cron). A mutex (in-process + lockfile) prevents overlapping refreshes.
 *
 * Scope guard: operates ONLY on existing collections; `collections` merely FILTERS
 * that list — it never accepts a URL/path for an unconfigured source.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { QMDStore } from "./index.js";

export type CollectionRefresh = {
  collection: string;
  kind: "git" | "local";
  /** git pull ran and succeeded (fast-forward). Always false for local sources. */
  pulled: boolean;
  /** reason, when the source's pull failed (isolated — does not affect the others). */
  pullError?: string;
};

export type RefreshSummary = {
  status: "ok" | "already_running";
  collections: CollectionRefresh[];
  indexed: number;
  updated: number;
  removed: number;
  /** chunks embedded in this pass. */
  embedded: number;
  durationMs: number;
};

/** qmd's cache directory (same convention as mcp.pid) — holds the lockfile. */
function cacheDir(): string {
  return process.env.XDG_CACHE_HOME
    ? resolve(process.env.XDG_CACHE_HOME, "qmd")
    : resolve(homedir(), ".cache", "qmd");
}

/** A refresh should never take this long; a lock older than this is considered orphaned. */
const LOCK_STALE_MS = 60 * 60 * 1000; // 1h

/** In-process lock (same process: agent + agent, or agent + in-process cron). */
let inProcessLock = false;

/**
 * Cross-process lock (server tool × the cron's `qmd refresh`, distinct processes).
 * Atomic creation via the "wx" flag; an orphaned lock (crash) is overridden by staleness.
 * Best-effort: if the lockfile cannot be written, the refresh is not blocked.
 */
function acquireFileLock(): boolean {
  const dir = cacheDir();
  const lockPath = join(dir, "refresh.lock");
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, String(Date.now()), { flag: "wx" });
      return true;
    } catch {
      // already exists — check staleness
      try {
        const ts = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
        if (!Number.isNaN(ts) && Date.now() - ts < LOCK_STALE_MS) return false; // live lock
        unlinkSync(lockPath); // orphaned → remove it and try again
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseFileLock(): void {
  try { unlinkSync(join(cacheDir(), "refresh.lock")); } catch { /* ignore */ }
}

/** Runs a short git and resolves with {code, stdout, stderr}; never rejects. */
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
 * Is the collection a git one? Detected via `rev-parse --is-inside-work-tree` from
 * `pwd`. Works even with `subdir`/sparse-checkout (the `.git` lives at the clone
 * root, an ancestor of pwd — `existsSync(pwd/.git)` would fail).
 */
async function isInsideGitWorkTree(pwd: string): Promise<boolean> {
  if (!existsSync(pwd)) return false;
  const r = await runGit(["-C", pwd, "rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

/**
 * git pull --ff-only from the collection's pwd. Git locates the work tree root on
 * its own (covers subdir), reuses the clone's `origin` (which already carries the
 * PAT) and preserves the sparse-checkout. --ff-only isolates divergence, no merge.
 */
async function gitPull(pwd: string): Promise<{ ok: boolean; error?: string }> {
  const r = await runGit(["-C", pwd, "pull", "--ff-only"]);
  if (r.code === 0) return { ok: true };
  return { ok: false, error: (r.stderr || r.stdout).trim() || `git exited with code ${r.code}` };
}

/**
 * Refreshes the configured sources (pull + reindex + embed). See the module doc.
 *
 * @param options.collections filters the existing collections (guard: only filters).
 * @param options.log         optional progress sink (the entrypoint/CLI logs it).
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

  // Mutex: cheap in-process one + cross-process lockfile. A refresh in flight →
  // returns already_running instead of running concurrently or queueing up.
  if (inProcessLock || !acquireFileLock()) return empty("already_running");
  inProcessLock = true;
  try {
    // Scope guard: ALWAYS starts from the existing collections; the filter only narrows.
    const all = await store.listCollections();
    const filter = options.collections?.filter((n) => n.length > 0);
    const selected = filter && filter.length > 0
      ? all.filter((c) => filter.includes(c.name))
      : all;

    // 1. pull per git collection (isolated failure); local ones only reindex, no pull.
    const perCollection: CollectionRefresh[] = [];
    for (const col of selected) {
      if (!(await isInsideGitWorkTree(col.pwd))) {
        perCollection.push({ collection: col.name, kind: "local", pulled: false });
        log(`[refresh] ${col.name}: local (no pull)`);
        continue;
      }
      const res = await gitPull(col.pwd);
      perCollection.push({ collection: col.name, kind: "git", pulled: res.ok, pullError: res.ok ? undefined : res.error });
      log(res.ok ? `[refresh] ${col.name}: git pull ok` : `[refresh] ${col.name}: git pull FAILED — ${res.error}`);
    }

    // 2. reindex (fs walk), scoped to the selected collections.
    const selectedNames = selected.map((c) => c.name);
    const upd = await store.update(selectedNames.length > 0 ? { collections: selectedNames } : {});

    // 3. embed only what is missing (idempotent; remote provider in this deploy).
    const emb = await store.embed();

    log(`[refresh] indexed=${upd.indexed} updated=${upd.updated} removed=${upd.removed} embedded=${emb.chunksEmbedded}`);
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

/** Human-readable summary of a RefreshSummary (shared by the tool and the CLI). */
export function formatRefreshSummary(s: RefreshSummary): string {
  if (s.status === "already_running") return "refresh already in progress — ignored";
  const secs = Math.round(s.durationMs / 1000);
  const head = `refresh: ${s.indexed} new, ${s.updated} updated, ${s.removed} removed, ${s.embedded} embedded (${secs}s)`;
  if (s.collections.length === 0) return `${head}\n  (no sources)`;
  const lines = s.collections.map((c) => {
    if (c.kind === "local") return `  ${c.collection}: local (reindex)`;
    return c.pulled ? `  ${c.collection}: pull ok` : `  ${c.collection}: pull FAILED (${c.pullError ?? "?"})`;
  });
  return `${head}\n${lines.join("\n")}`;
}
