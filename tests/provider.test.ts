import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type {
  AuthContext,
  Credential,
  Model,
  RefreshModelsContext,
} from "@earendil-works/pi-ai/compat";
import type { DiscoveredModel, LiteLLMApi } from "../src/discover.ts";
import {
  createLiteLLMProvider,
  ENV_API_KEY,
  ENV_BASE_URL,
  login,
  modelBaseUrl,
  resolveRoot,
  toPiModel,
} from "../src/provider.ts";

const ROOT = "https://llm.example.com";

const ctxWithEnv = (env: Record<string, string | undefined> = {}): AuthContext => ({
  env: async (name) => env[name],
  fileExists: async () => false,
});

const stored = (key: string, root = ROOT): Credential => ({
  type: "api_key",
  key,
  env: { [ENV_BASE_URL]: root },
});

const discovered = (id: string, api: LiteLLMApi): DiscoveredModel => ({
  id,
  api,
  reasoning: false,
  vision: false,
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

describe("modelBaseUrl / toPiModel", () => {
  it("points Anthropic at the root and OpenAI APIs at /v1", () => {
    assert.equal(modelBaseUrl(ROOT, "anthropic-messages"), ROOT);
    assert.equal(modelBaseUrl(ROOT, "openai-responses"), `${ROOT}/v1`);
    assert.equal(modelBaseUrl(ROOT, "openai-completions"), `${ROOT}/v1`);
  });

  it("builds a pi chat model with provider id and modalities", () => {
    const m = toPiModel(ROOT, {
      ...discovered("x", "openai-completions"),
      vision: true,
      reasoning: true,
    });
    assert.equal(m.provider, "litellm");
    assert.equal(m.name, "x");
    assert.deepEqual(m.input, ["text", "image"]);
    assert.equal(m.reasoning, true);
    assert.equal(m.baseUrl, `${ROOT}/v1`);
  });
});

describe("resolveRoot", () => {
  it("prefers the stored root, then the environment, normalized", async () => {
    assert.equal(
      await resolveRoot(ctxWithEnv({ [ENV_BASE_URL]: "https://env/v1" }), stored("k", `${ROOT}/`)),
      ROOT,
    );
    assert.equal(
      await resolveRoot(ctxWithEnv({ [ENV_BASE_URL]: "https://env/v1/" }), undefined),
      "https://env",
    );
    assert.equal(await resolveRoot(ctxWithEnv(), undefined), undefined);
    assert.equal(
      await resolveRoot(ctxWithEnv({ [ENV_BASE_URL]: "not a url" }), undefined),
      undefined,
    );
  });
});

describe("auth", () => {
  const provider = createLiteLLMProvider();
  const apiKey = provider.auth.apiKey!;
  const signal = new AbortController().signal;

  it("resolves a stored credential without an auth.baseUrl override", async () => {
    const result = await apiKey.resolve({
      ctx: ctxWithEnv(),
      credential: stored("sk-1") as never,
      signal,
    });
    assert.deepEqual(result, {
      auth: { apiKey: "sk-1" },
      env: { [ENV_BASE_URL]: ROOT },
      source: "stored credential",
    });
  });

  it("falls back to LITELLM_API_KEY / LITELLM_BASE_URL", async () => {
    const ctx = ctxWithEnv({ [ENV_API_KEY]: "sk-env", [ENV_BASE_URL]: `${ROOT}/v1` });
    const result = await apiKey.resolve({ ctx, credential: undefined, signal });
    assert.equal(result?.auth.apiKey, "sk-env");
    assert.equal(result?.env?.[ENV_BASE_URL], ROOT);
    assert.equal(result?.source, ENV_API_KEY);
    assert.deepEqual(await apiKey.check!({ ctx, credential: undefined, signal }), {
      type: "api_key",
      source: ENV_API_KEY,
    });
  });

  it("is unconfigured without a root or without a key", async () => {
    assert.equal(
      await apiKey.resolve({
        ctx: ctxWithEnv({ [ENV_API_KEY]: "k" }),
        credential: undefined,
        signal,
      }),
      undefined,
    );
    assert.equal(
      await apiKey.resolve({
        ctx: ctxWithEnv({ [ENV_BASE_URL]: ROOT }),
        credential: undefined,
        signal,
      }),
      undefined,
    );
    assert.equal(
      await apiKey.check!({ ctx: ctxWithEnv(), credential: undefined, signal }),
      undefined,
    );
  });
});

describe("login", () => {
  it("normalizes the URL, probes the proxy and stores root in env", async () => {
    const answers = [`${ROOT}/v1/`, "  sk-new  "];
    const notices: string[] = [];
    const credential = await login(
      {
        signal: new AbortController().signal,
        prompt: async () => answers.shift()!,
        notify: (e) => notices.push(e.type),
      },
      async () => ({ models: [discovered("m", "openai-completions")], source: "/model/info" }),
    );
    assert.deepEqual(credential, { type: "api_key", key: "sk-new", env: { [ENV_BASE_URL]: ROOT } });
    assert.deepEqual(notices, ["progress", "info"]);
  });

  it("calls onLoginStart before any prompt", async () => {
    const order: string[] = [];
    await login(
      {
        signal: new AbortController().signal,
        prompt: async (p) => {
          order.push("prompt");
          return p.type === "text" ? ROOT : "k";
        },
        notify: () => {},
      },
      async () => ({ models: [], source: "/v1/models" as const }),
      () => order.push("start"),
    );
    assert.deepEqual(order, ["start", "prompt", "prompt"]);
  });

  it("rejects empty keys and bad URLs before contacting anything", async () => {
    let probed = false;
    const probe = async () => {
      probed = true;
      return { models: [], source: "/v1/models" as const };
    };
    const mk = (answers: string[]) => ({
      signal: new AbortController().signal,
      prompt: async () => answers.shift()!,
      notify: () => {},
    });
    await assert.rejects(login(mk(["nope", "k"]), probe), /absolute http/);
    await assert.rejects(login(mk([ROOT, "   "]), probe), /empty/);
    assert.equal(probed, false);
  });
});

describe("fetchModels / filterModels", () => {
  const discoverCalls: Array<{ root: string; key: string }> = [];
  const provider = createLiteLLMProvider({
    discover: async (root, key) => {
      discoverCalls.push({ root, key });
      return {
        models: [discovered("claude", "anthropic-messages"), discovered("gpt", "openai-responses")],
        source: "/model/info",
      };
    },
  });
  afterEach(() => discoverCalls.splice(0));

  const refresh = async (credential: Credential | undefined) => {
    let published: Model<LiteLLMApi>[] = [];
    const context: RefreshModelsContext = {
      credential,
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async (p) => {
        p.update?.();
        if (p.persist) published = p.persist.models as Model<LiteLLMApi>[];
        return true;
      },
    };
    await provider.refreshModels!(context);
    return published;
  };

  it("discovers with the resolved credential and persists per-API base URLs", async () => {
    const models = await refresh(stored("sk-1"));
    assert.deepEqual(discoverCalls, [{ root: ROOT, key: "sk-1" }]);
    assert.deepEqual(
      models.map((m) => [m.id, m.api, m.baseUrl]),
      [
        ["claude", "anthropic-messages", ROOT],
        ["gpt", "openai-responses", `${ROOT}/v1`],
      ],
    );
    assert.deepEqual(
      provider.getModels().map((m) => m.id),
      ["claude", "gpt"],
    );
  });

  it("refuses to discover without a key or root", async () => {
    await assert.rejects(refresh(undefined), /API key/);
    await assert.rejects(refresh({ type: "api_key", key: "k" }), /proxy URL/);
    assert.equal(discoverCalls.length, 0);
  });

  it("hides cached models that belong to a different proxy", async () => {
    await refresh(stored("sk-1"));
    const all = provider.getModels();
    assert.equal(provider.filterModels!(all, stored("sk-1")).length, 2);
    assert.equal(
      provider.filterModels!(all, stored("sk-1", "https://other.example.com")).length,
      0,
    );
    assert.equal(provider.filterModels!(all, undefined).length, 0);
  });

  it("falls back to process.env for the root when nothing is stored", async () => {
    await refresh(stored("sk-1"));
    const previous = process.env[ENV_BASE_URL];
    process.env[ENV_BASE_URL] = `${ROOT}/v1`;
    try {
      assert.equal(provider.filterModels!(provider.getModels(), undefined).length, 2);
    } finally {
      if (previous === undefined) delete process.env[ENV_BASE_URL];
      else process.env[ENV_BASE_URL] = previous;
    }
  });
});
