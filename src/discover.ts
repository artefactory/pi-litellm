/**
 * Model discovery from a LiteLLM proxy.
 *
 * Pure functions only: no I/O happens here except in `discoverModels`, which takes
 * a `fetch`-compatible function so tests can drive it with canned responses.
 */

/** Chat APIs this extension can route a LiteLLM model through. */
export type LiteLLMApi = "anthropic-messages" | "openai-responses" | "openai-completions";

/** One route as reported by `GET /model/info`. Only the fields we read. */
export interface ModelInfoEntry {
  model_name: string;
  litellm_params?: { model?: string };
  model_info?: {
    mode?: string | null;
    litellm_provider?: string | null;
    supported_endpoints?: string[] | null;
    max_input_tokens?: number | null;
    max_output_tokens?: number | null;
    max_tokens?: number | null;
    input_cost_per_token?: number | null;
    output_cost_per_token?: number | null;
    cache_read_input_token_cost?: number | null;
    cache_creation_input_token_cost?: number | null;
    supports_vision?: boolean | null;
    supports_reasoning?: boolean | null;
  };
}

/** Provider-neutral description of a chat route, before it becomes a pi `Model`. */
export interface DiscoveredModel {
  id: string;
  api: LiteLLMApi;
  reasoning: boolean;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  /** USD per million tokens, pi's unit. */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

/** LiteLLM adapters that speak Anthropic Messages upstream. */
const ANTHROPIC_PROVIDERS = new Set([
  "anthropic",
  "vertex_ai-anthropic_models",
  "bedrock",
  "bedrock_converse",
]);

/** LiteLLM adapters that can serve the OpenAI Responses API upstream. */
const RESPONSES_PROVIDERS = new Set(["openai", "azure"]);

/**
 * Pick the wire protocol for one route. Decided from LiteLLM metadata, never from
 * the alias the operator chose:
 *
 * 1. `anthropic-messages` when the adapter is an Anthropic one AND the backend model
 *    string contains `claude` (keeps Llama-on-Bedrock on chat/completions).
 * 2. `openai-responses` when the adapter is OpenAI/Azure AND `supported_endpoints`
 *    explicitly lists `/v1/responses`. A `null` list means LiteLLM has no model-map
 *    entry, so we do not guess.
 * 3. `openai-completions` otherwise.
 */
export function selectApi(entry: ModelInfoEntry): LiteLLMApi {
  const info = entry.model_info ?? {};
  const provider = info.litellm_provider ?? "";
  const backend = (entry.litellm_params?.model ?? "").toLowerCase();

  if (ANTHROPIC_PROVIDERS.has(provider) && backend.includes("claude")) {
    return "anthropic-messages";
  }
  if (RESPONSES_PROVIDERS.has(provider) && info.supported_endpoints?.includes("/v1/responses")) {
    return "openai-responses";
  }
  return "openai-completions";
}

/** True when a `/model/info` entry is a chat route pi can use. */
export function isChatRoute(entry: ModelInfoEntry): boolean {
  if (!entry.model_name) return false;
  const info = entry.model_info ?? {};
  // LiteLLM reports `mode: null` for auto-routers and routes missing from its model
  // map. Routers are excluded (no metadata, unpredictable backend); other null-mode
  // routes are kept on chat/completions with default limits.
  if (info.litellm_provider === "auto_router") return false;
  return info.mode == null || info.mode === "chat";
}

/** LiteLLM reports USD per token; pi wants USD per million. Rounded to kill float noise. */
function perMillion(perToken: number | null | undefined): number {
  if (typeof perToken !== "number" || !Number.isFinite(perToken) || perToken < 0) return 0;
  return Math.round(perToken * 1_000_000 * 1_000_000) / 1_000_000;
}

function positiveInt(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function toDiscoveredModel(entry: ModelInfoEntry): DiscoveredModel {
  const info = entry.model_info ?? {};
  const contextWindow = positiveInt(info.max_input_tokens, DEFAULT_CONTEXT_WINDOW);
  // Output limit must never exceed the context window; some upstreams report odd values.
  const maxTokens = Math.min(
    positiveInt(info.max_output_tokens ?? info.max_tokens, DEFAULT_MAX_TOKENS),
    contextWindow,
  );
  return {
    id: entry.model_name,
    api: selectApi(entry),
    reasoning: info.supports_reasoning === true,
    vision: info.supports_vision === true,
    contextWindow,
    maxTokens,
    cost: {
      input: perMillion(info.input_cost_per_token),
      output: perMillion(info.output_cost_per_token),
      cacheRead: perMillion(info.cache_read_input_token_cost),
      cacheWrite: perMillion(info.cache_creation_input_token_cost),
    },
  };
}

/**
 * Collapse `/model/info` (one entry per deployment) into one model per route name.
 * When a route has several deployments, the first one decides transport and the
 * limits are the minimum across deployments, so a request never exceeds any of them.
 */
export function fromModelInfo(entries: ModelInfoEntry[]): DiscoveredModel[] {
  const byName = new Map<string, DiscoveredModel>();
  for (const entry of entries) {
    if (!isChatRoute(entry)) continue;
    const model = toDiscoveredModel(entry);
    const existing = byName.get(model.id);
    if (!existing) {
      byName.set(model.id, model);
      continue;
    }
    byName.set(model.id, {
      ...existing,
      contextWindow: Math.min(existing.contextWindow, model.contextWindow),
      maxTokens: Math.min(existing.maxTokens, model.maxTokens),
      reasoning: existing.reasoning && model.reasoning,
      vision: existing.vision && model.vision,
    });
  }
  return [...byName.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** `/v1/models` carries no metadata: everything goes to chat/completions with defaults. */
export function fromV1Models(ids: string[]): DiscoveredModel[] {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      id,
      api: "openai-completions" as const,
      reasoning: false,
      vision: false,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
}

/**
 * Normalize what the user typed into a proxy root: `https://host[/prefix]`, no
 * trailing slash, no trailing `/v1`. Rejects anything that is not http(s), and
 * plain http outside loopback (the key would travel in clear).
 */
export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Base URL must be an absolute http(s) URL, e.g. https://litellm.example.com");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Base URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Base URL must not contain credentials");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Plain http is only allowed for localhost; use https");
  }
  url.search = "";
  url.hash = "";
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -3);
  return `${url.origin}${path}`;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiscoveryResult {
  models: DiscoveredModel[];
  /** Which endpoint produced the list. */
  source: "/model/info" | "/v1/models";
}

/**
 * Discover chat models. `/model/info` first (rich metadata); when the key is not
 * allowed to read it (401/403/404) or it is empty, fall back to `/v1/models`.
 */
export async function discoverModels(
  baseUrl: string,
  apiKey: string,
  options: { fetch?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<DiscoveryResult> {
  const fetchFn = options.fetch ?? fetch;
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

  const get = async (path: string): Promise<Response> => {
    options.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    return fetchFn(`${baseUrl}${path}`, { headers, signal, redirect: "error" });
  };

  const infoResponse = await get("/model/info");
  if (infoResponse.ok) {
    const body = (await infoResponse.json()) as { data?: unknown };
    const entries = Array.isArray(body.data) ? (body.data as ModelInfoEntry[]) : [];
    const models = fromModelInfo(entries);
    if (models.length > 0) return { models, source: "/model/info" };
  } else if (![401, 403, 404].includes(infoResponse.status)) {
    throw new Error(`LiteLLM /model/info failed: HTTP ${infoResponse.status}`);
  }

  const listResponse = await get("/v1/models");
  if (!listResponse.ok) {
    throw new Error(`LiteLLM /v1/models failed: HTTP ${listResponse.status}`);
  }
  const body = (await listResponse.json()) as { data?: Array<{ id?: unknown }> };
  const ids = Array.isArray(body.data)
    ? body.data.map((m) => m?.id).filter((id): id is string => typeof id === "string")
    : [];
  return { models: fromV1Models(ids), source: "/v1/models" };
}
