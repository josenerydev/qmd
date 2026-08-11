/**
 * openai-compat.ts — backend de LLM REMOTO para o QMD.
 *
 * Implementa o contrato `LLM` (embed/embedBatch/rerank + stubs) contra um endpoint
 * HTTP configurável, compatível com a API da OpenAI (embeddings) e com rerank
 * estilo Cohere. Serve qualquer provedor/proxy OpenAI-compat — direto (OpenAI,
 * OpenRouter, ...) ou atrás de um gateway, à escolha do deploy. Sem inferência
 * local, sem modelos GGUF. Selecionado por env (ver getDefaultLLM em llm.ts).
 *
 * Importa apenas TIPOS de llm.ts → sem dependência de runtime (evita ciclo de import).
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
      throw new Error("QMD_LLM_API_KEY não definida — o provider remoto exige credencial.");
    }
    if (!config.baseUrl) {
      throw new Error("QMD_LLM_BASE_URL não definida — o provider remoto exige um endpoint.");
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

  /** POST /rerank (estilo Cohere). Degrada para a ordem de entrada se indisponível. */
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
      console.warn(`[openai-compat] rerank indisponível, mantendo ordem de entrada: ${msg}`);
      const results = documents.map((d, index) => ({
        file: d.file,
        score: 1 - index / documents.length,
        index,
      }));
      return { results, model };
    }
  }

  /**
   * Expansion desligada no modo remoto: o agente envia sub-queries tipadas
   * (lex/vec/hyde) direto na tool `query` do MCP. Stub sem chamada de rede.
   */
  async expandQuery(query: string): Promise<Queryable[]> {
    return [{ type: "vec", text: query }];
  }

  /** Não usado no caminho remoto (expandQuery é stub). */
  async generate(_prompt: string, _options?: GenerateOptions): Promise<GenerateResult | null> {
    return null;
  }

  async modelExists(model: string): Promise<ModelInfo> {
    return { name: model, exists: true };
  }

  async dispose(): Promise<void> {
    // HTTP stateless — nada a liberar.
  }
}
