/**
 * openai-compat.ts — REMOTE LLM backend for QMD.
 *
 * Implements the `LLM` contract (embed/embedBatch/rerank + stubs) against a
 * configurable HTTP endpoint, compatible with the OpenAI API (embeddings) and with
 * Cohere-style rerank. Serves any OpenAI-compat provider/proxy — directly (OpenAI,
 * OpenRouter, ...) or behind a gateway, at the deploy's discretion. No local
 * inference, no GGUF models. Selected by env (see getDefaultLLM in llm.ts).
 *
 * Imports only TYPES from llm.ts → no runtime dependency (avoids an import cycle).
 */
import type {
  LLM,
  EmbeddingResult,
  EmbedOptions,
  GenerateResult,
  GenerateOptions,
  ModelInfo,
  Queryable,
  RerankDocument,
  RerankResult,
  RerankOptions,
} from "./llm.js";

export type OpenAICompatConfig = {
  baseUrl: string;
  apiKey: string;
  embedModel: string;
  rerankModel: string;
  generateModel: string;
};

export class OpenAICompatLLM implements LLM {
  constructor(private readonly config: OpenAICompatConfig) {
    if (!config.apiKey) {
      throw new Error("QMD_LLM_API_KEY is not set — the remote provider requires a credential.");
    }
    if (!config.baseUrl) {
      throw new Error("QMD_LLM_BASE_URL is not set — the remote provider requires an endpoint.");
    }
  }

  get embedModelName(): string { return this.config.embedModel; }
  get rerankModelName(): string { return this.config.rerankModel; }
  get generateModelName(): string { return this.config.generateModel; }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  /** POST /embeddings (OpenAI-compatible); retorna vetores na ordem dos inputs. */
  private async embedInputs(inputs: string[], model: string): Promise<(number[] | null)[]> {
    const resp = await fetch(`${this.config.baseUrl}/embeddings`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, input: inputs }),
    });
    if (!resp.ok) {
      throw new Error(`embeddings ${resp.status}: ${await resp.text()}`);
    }
    const json = (await resp.json()) as { data: Array<{ embedding: number[]; index?: number }> };
    const out: (number[] | null)[] = new Array(inputs.length).fill(null);
    json.data.forEach((d, i) => {
      out[d.index ?? i] = d.embedding;
    });
    return out;
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    const model = options?.model ?? this.config.embedModel;
    const [embedding] = await this.embedInputs([text], model);
    return embedding ? { embedding, model } : null;
  }

  async embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    if (texts.length === 0) return [];
    const model = options?.model ?? this.config.embedModel;
    const vectors = await this.embedInputs(texts, model);
    return vectors.map((v) => (v ? { embedding: v, model } : null));
  }

  /** POST /rerank (Cohere style). Degrades to the input order when unavailable. */
  async rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult> {
    const model = options?.model ?? this.config.rerankModel;
    if (documents.length === 0) return { results: [], model };
    try {
      const resp = await fetch(`${this.config.baseUrl}/rerank`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ model, query, documents: documents.map((d) => d.text) }),
      });
      if (!resp.ok) throw new Error(`rerank ${resp.status}: ${await resp.text()}`);
      const json = (await resp.json()) as { results: Array<{ index: number; relevance_score: number }> };
      const results = json.results
        .map((r) => ({ file: documents[r.index]!.file, score: r.relevance_score, index: r.index }))
        .sort((a, b) => b.score - a.score);
      return { results, model };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[openai-compat] rerank unavailable, keeping the input order: ${msg}`);
      const results = documents.map((d, index) => ({
        file: d.file,
        score: 1 - index / documents.length,
        index,
      }));
      return { results, model };
    }
  }

  /**
   * Expansion is off in remote mode: the agent sends typed sub-queries
   * (lex/vec/hyde) straight to the MCP `query` tool. Stub, no network call.
   */
  async expandQuery(query: string): Promise<Queryable[]> {
    return [{ type: "vec", text: query }];
  }

  /** Unused on the remote path (expandQuery is a stub). */
  async generate(_prompt: string, _options?: GenerateOptions): Promise<GenerateResult | null> {
    return null;
  }

  async modelExists(model: string): Promise<ModelInfo> {
    return { name: model, exists: true };
  }

  async dispose(): Promise<void> {
    // Stateless HTTP — nothing to release.
  }
}
