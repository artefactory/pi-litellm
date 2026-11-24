/**
 * Native pi provider for a LiteLLM proxy.
 *
 * Auth: one API key plus the proxy root, stored by `/login litellm` in pi's
 * `auth.json` as `{ type: "api_key", key, env: { LITELLM_BASE_URL } }`, or taken
 * from `LITELLM_API_KEY` / `LITELLM_BASE_URL` when nothing is stored.
 *
 * Models: discovered from the proxy, persisted by pi's models store, and routed
 * per model to pi-ai's Anthropic Messages, OpenAI Responses or OpenAI Chat
 * Completions implementation. No custom streaming code.
 */

import {
  anthropicMessagesApi,
  createProvider,
  openAICompletionsApi,
  openAIResponsesApi,
  type ApiKeyCredential,
  type AuthContext,
  type Credential,
  type Model,
  type Provider,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai/compat";
import {
  discoverModels,
  normalizeBaseUrl,
  type DiscoveredModel,
  type LiteLLMApi,
} from "./discover.ts";

export const PROVIDER_ID = "litellm";
export const PROVIDER_NAME = "LiteLLM";
export const ENV_BASE_URL = "LITELLM_BASE_URL";
export const ENV_API_KEY = "LITELLM_API_KEY";

/** Where each pi-ai implementation expects to be pointed, relative to the proxy root. */
export function modelBaseUrl(root: string, api: LiteLLMApi): string {
  // The Anthropic SDK appends `/v1/messages`; the OpenAI SDK appends `/chat/completions`
  // or `/responses` to a base that already ends in `/v1`.
  return api === "anthropic-messages" ? root : `${root}/v1`;
}

export function toPiModel(root: string, discovered: DiscoveredModel): Model<LiteLLMApi> {
  return {
    id: discovered.id,
    name: discovered.id,
    api: discovered.api,
    provider: PROVIDER_ID,
    baseUrl: modelBaseUrl(root, discovered.api),
    reasoning: discovered.reasoning,
    input: discovered.vision ? ["text", "image"] : ["text"],
    cost: discovered.cost,
    contextWindow: discovered.contextWindow,
    maxTokens: discovered.maxTokens,
  } as Model<LiteLLMApi>;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function safeRoot(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return normalizeBaseUrl(raw);
  } catch {
    return undefined;
  }
}

function storedRoot(credential: Credential | undefined): string | undefined {
  return credential?.type === "api_key" ? clean(credential.env?.[ENV_BASE_URL]) : undefined;
}

/** Proxy root for a credential: stored at login, else from the environment. */
export async function resolveRoot(
  ctx: AuthContext,
  credential: Credential | undefined,
): Promise<string | undefined> {
  return safeRoot(storedRoot(credential) ?? clean(await ctx.env(ENV_BASE_URL)));
}

export async function login(
  interaction: ProviderAuthInteraction,
  discover: typeof discoverModels = discoverModels,
  onLoginStart?: () => void,
): Promise<ApiKeyCredential> {
  // Runs before pi stores anything, so a consumer of the current credential (the MCP
  // bridge) can let go of the old proxy before the new key exists.
  onLoginStart?.();
  const url = await interaction.prompt({
    type: "text",
    message: "LiteLLM proxy URL",
    placeholder: "https://litellm.example.com",
  });
  const root = normalizeBaseUrl(url);
  const key = (await interaction.prompt({ type: "secret", message: "LiteLLM API key" })).trim();
  if (!key) throw new Error("API key must not be empty");

  interaction.notify({ type: "progress", message: "Checking the proxy…" });
  const result = await discover(root, key, { signal: interaction.signal });
  interaction.notify({
    type: "info",
    message: `${result.models.length} chat model(s) available via ${result.source}`,
  });
  return { type: "api_key", key, env: { [ENV_BASE_URL]: root } };
}

export interface CreateLiteLLMProviderOptions {
  /** Injected for tests. */
  discover?: typeof discoverModels;
  /** Called when `/login litellm` starts, before any prompt and before the credential is stored. */
  onLoginStart?: () => void;
}

export function createLiteLLMProvider(
  options: CreateLiteLLMProviderOptions = {},
): Provider<LiteLLMApi> {
  const discover = options.discover ?? discoverModels;

  return createProvider<LiteLLMApi>({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    auth: {
      apiKey: {
        name: `${PROVIDER_NAME} API key`,
        login: (interaction) => login(interaction, discover, options.onLoginStart),
        async check({ ctx, credential }) {
          const root = await resolveRoot(ctx, credential);
          if (!root) return undefined;
          if (clean(credential?.key)) return { type: "api_key", source: "stored credential" };
          if (clean(await ctx.env(ENV_API_KEY))) return { type: "api_key", source: ENV_API_KEY };
          return undefined;
        },
        async resolve({ ctx, credential }) {
          const root = await resolveRoot(ctx, credential);
          if (!root) return undefined;
          const storedKey = clean(credential?.key);
          const key = storedKey ?? clean(await ctx.env(ENV_API_KEY));
          if (!key) return undefined;
          // No `auth.baseUrl` here: pi would overwrite every model's baseUrl with it,
          // and Anthropic vs OpenAI models need different ones. The root travels in
          // `env` so `fetchModels` and `filterModels` can see it.
          return {
            auth: { apiKey: key },
            env: { [ENV_BASE_URL]: root },
            source: storedKey ? "stored credential" : ENV_API_KEY,
          };
        },
      },
    },
    models: [],
    async fetchModels(context) {
      const credential = context.credential;
      if (credential?.type !== "api_key" || !credential.key) {
        throw new Error("LiteLLM discovery needs an API key; run /login litellm");
      }
      const root = clean(credential.env?.[ENV_BASE_URL]);
      if (!root) throw new Error("LiteLLM discovery needs a proxy URL; run /login litellm");
      const result = await discover(root, credential.key, { signal: context.signal });
      return result.models.map((model) => toPiModel(root, model));
    },
    filterModels(models, credential) {
      // Only expose models discovered from the proxy the current credential points at.
      // A cached catalog from a previous proxy must never receive this key.
      // pi passes the *stored* credential here (sync, no AuthContext), so an
      // env-only setup falls back to process.env.
      const root = safeRoot(storedRoot(credential) ?? clean(process.env[ENV_BASE_URL]));
      if (!root) return [];
      return models.filter((model) => model.baseUrl === modelBaseUrl(root, model.api));
    },
    api: {
      "anthropic-messages": anthropicMessagesApi(),
      "openai-responses": openAIResponsesApi(),
      "openai-completions": openAICompletionsApi(),
    },
  });
}
