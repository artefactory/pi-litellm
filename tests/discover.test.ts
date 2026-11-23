import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  discoverModels,
  fromModelInfo,
  fromV1Models,
  isChatRoute,
  normalizeBaseUrl,
  selectApi,
  type ModelInfoEntry,
} from "../src/discover.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures-model-info.json", import.meta.url), "utf8"),
) as ModelInfoEntry[];

const byName = (name: string): ModelInfoEntry => {
  const entry = fixture.find((e) => e.model_name === name);
  if (!entry) throw new Error(`fixture missing ${name}`);
  return entry;
};

describe("selectApi", () => {
  it("routes Claude on Vertex through Anthropic Messages", () => {
    assert.equal(selectApi(byName("claude-opus-4-8")), "anthropic-messages");
  });

  it("routes OpenAI models that list /v1/responses through Responses", () => {
    assert.equal(selectApi(byName("gpt-6.1-terra-oai")), "openai-responses");
  });

  it("keeps OpenAI models with null supported_endpoints on Chat Completions", () => {
    assert.equal(selectApi(byName("gpt-6.2-sol-oai")), "openai-completions");
  });

  it("keeps Gemini, OpenRouter and Gemma routes on Chat Completions", () => {
    for (const name of ["gemini-3.5-flash", "glm-5.3-flash-or", "gemma-4"]) {
      assert.equal(selectApi(byName(name)), "openai-completions", name);
    }
  });

  it("never picks Anthropic for a non-Claude model on an Anthropic-capable adapter", () => {
    assert.equal(
      selectApi({
        model_name: "llama-bedrock",
        litellm_params: { model: "bedrock/meta.llama3-70b-instruct-v1:0" },
        model_info: { litellm_provider: "bedrock", mode: "chat" },
      }),
      "openai-completions",
    );
  });

  it("picks Anthropic for Claude on Bedrock and on the direct adapter", () => {
    assert.equal(
      selectApi({
        model_name: "c",
        litellm_params: { model: "bedrock/anthropic.claude-sonnet" },
        model_info: { litellm_provider: "bedrock_converse", mode: "chat" },
      }),
      "anthropic-messages",
    );
    assert.equal(
      selectApi({
        model_name: "c",
        litellm_params: { model: "anthropic/claude-haiku" },
        model_info: { litellm_provider: "anthropic", mode: "chat" },
      }),
      "anthropic-messages",
    );
  });

  it("ignores the operator alias: 'claude' via OpenRouter stays on Chat Completions", () => {
    assert.equal(
      selectApi({
        model_name: "claude-via-openrouter",
        litellm_params: { model: "openrouter/anthropic/claude-sonnet" },
        model_info: { litellm_provider: "openrouter", mode: "chat" },
      }),
      "openai-completions",
    );
  });

  it("does not pick Responses without an explicit endpoint list", () => {
    assert.equal(
      selectApi({
        model_name: "gpt",
        litellm_params: { model: "openai/gpt-x" },
        model_info: {
          litellm_provider: "openai",
          mode: "chat",
          supported_endpoints: ["/v1/chat/completions"],
        },
      }),
      "openai-completions",
    );
  });
});

describe("isChatRoute", () => {
  it("keeps chat routes and null-mode routes, drops other modes and routers", () => {
    assert.equal(isChatRoute(byName("claude-opus-4-8")), true);
    assert.equal(isChatRoute(byName("text-embedding-005")), false);
    assert.equal(isChatRoute(byName("whisper-large-v3-turbo-or")), false);
    assert.equal(isChatRoute(byName("gemini-nano-banana-2.1-global")), false);
    assert.equal(isChatRoute(byName("smart_glm_router")), false);
    assert.equal(isChatRoute({ model_name: "custom", model_info: { mode: null } }), true);
    assert.equal(isChatRoute({ model_name: "" }), false);
  });
});

describe("fromModelInfo", () => {
  it("maps the real fixture to the expected chat models", () => {
    const models = fromModelInfo(fixture);
    assert.deepEqual(
      models.map((m) => m.id),
      [
        "claude-opus-4-8",
        "gemini-3.5-flash",
        "gemma-4",
        "glm-5.3-flash-or",
        "gpt-6.1-terra-oai",
        "gpt-6.2-sol-oai",
      ],
    );
    const claude = models.find((m) => m.id === "claude-opus-4-8")!;
    assert.equal(claude.api, "anthropic-messages");
    assert.equal(claude.reasoning, true);
    assert.equal(claude.vision, true);
    assert.equal(claude.contextWindow, 1_000_000);
    assert.equal(claude.maxTokens, 128_000);
    // $5 / $25 per million
    assert.ok(Math.abs(claude.cost.input - 5) < 1e-9);
    assert.ok(Math.abs(claude.cost.output - 25) < 1e-9);
  });

  it("merges deployments of one route with minimum limits", () => {
    const models = fromModelInfo([
      {
        model_name: "x",
        model_info: {
          mode: "chat",
          max_input_tokens: 200_000,
          max_output_tokens: 8_000,
          supports_reasoning: true,
        },
      },
      {
        model_name: "x",
        model_info: {
          mode: "chat",
          max_input_tokens: 100_000,
          max_output_tokens: 16_000,
          supports_reasoning: false,
        },
      },
    ]);
    assert.equal(models.length, 1);
    assert.equal(models[0]!.contextWindow, 100_000);
    assert.equal(models[0]!.maxTokens, 8_000);
    assert.equal(models[0]!.reasoning, false);
  });

  it("applies defaults for missing limits and caps maxTokens at the context window", () => {
    const [a, b] = fromModelInfo([
      { model_name: "a", model_info: { mode: "chat" } },
      {
        model_name: "b",
        model_info: { mode: "chat", max_input_tokens: 4_000, max_output_tokens: 9_000 },
      },
    ]);
    assert.equal(a!.contextWindow, DEFAULT_CONTEXT_WINDOW);
    assert.equal(a!.maxTokens, DEFAULT_MAX_TOKENS);
    assert.equal(b!.maxTokens, 4_000);
  });
});

describe("fromV1Models", () => {
  it("dedupes, sorts and uses chat/completions with zero cost", () => {
    const models = fromV1Models(["b", "a", "b", ""]);
    assert.deepEqual(
      models.map((m) => m.id),
      ["a", "b"],
    );
    assert.equal(models[0]!.api, "openai-completions");
    assert.deepEqual(models[0]!.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("normalizeBaseUrl", () => {
  it("strips trailing slash, /v1, query and fragment", () => {
    assert.equal(normalizeBaseUrl("https://llm.example.com/"), "https://llm.example.com");
    assert.equal(normalizeBaseUrl("https://llm.example.com/v1"), "https://llm.example.com");
    assert.equal(
      normalizeBaseUrl("https://llm.example.com/prefix/v1/?x=1#f"),
      "https://llm.example.com/prefix",
    );
    assert.equal(normalizeBaseUrl("  https://LLM.example.com  "), "https://llm.example.com");
  });

  it("allows plain http only on loopback", () => {
    assert.equal(normalizeBaseUrl("http://localhost:4000"), "http://localhost:4000");
    assert.equal(normalizeBaseUrl("http://127.0.0.1:4000/v1"), "http://127.0.0.1:4000");
    assert.throws(() => normalizeBaseUrl("http://llm.example.com"), /https/);
  });

  it("rejects garbage, other schemes and embedded credentials", () => {
    assert.throws(() => normalizeBaseUrl("llm.example.com"));
    assert.throws(() => normalizeBaseUrl("ftp://llm.example.com"));
    assert.throws(() => normalizeBaseUrl("https://user:pw@llm.example.com"), /credentials/);
  });
});

describe("discoverModels", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("uses /model/info when readable and sends the bearer key", async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const result = await discoverModels("https://p", "sk-test", {
      fetch: async (url, init) => {
        calls.push({ url, auth: new Headers(init?.headers).get("authorization") ?? undefined });
        return json(200, { data: fixture });
      },
    });
    assert.equal(result.source, "/model/info");
    assert.equal(result.models.length, 6);
    assert.deepEqual(calls, [{ url: "https://p/model/info", auth: "Bearer sk-test" }]);
  });

  it("falls back to /v1/models on 401/403/404 or an empty list", async () => {
    for (const status of [401, 403, 404]) {
      const result = await discoverModels("https://p", "k", {
        fetch: async (url) =>
          url.endsWith("/model/info")
            ? json(status, {})
            : json(200, { data: [{ id: "m1" }, { id: "m2" }] }),
      });
      assert.equal(result.source, "/v1/models", String(status));
      assert.deepEqual(
        result.models.map((m) => m.id),
        ["m1", "m2"],
      );
    }
    const empty = await discoverModels("https://p", "k", {
      fetch: async (url) =>
        url.endsWith("/model/info") ? json(200, { data: [] }) : json(200, { data: [{ id: "m" }] }),
    });
    assert.equal(empty.source, "/v1/models");
  });

  it("throws on other /model/info errors and on /v1/models failure", async () => {
    await assert.rejects(
      discoverModels("https://p", "k", { fetch: async () => json(500, {}) }),
      /model\/info failed: HTTP 500/,
    );
    await assert.rejects(
      discoverModels("https://p", "k", {
        fetch: async (url) => (url.endsWith("/model/info") ? json(403, {}) : json(401, {})),
      }),
      /v1\/models failed: HTTP 401/,
    );
  });

  it("honours the caller's abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      discoverModels("https://p", "k", {
        signal: controller.signal,
        fetch: async (_url, init) => {
          init?.signal?.throwIfAborted();
          return json(200, { data: [] });
        },
      }),
    );
  });
});
