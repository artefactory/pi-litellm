import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext, McpServerConfig } from "@earendil-works/pi-coding-agent";

type McpHttpServerConfig = Extract<McpServerConfig, { url: string }>;
import { createMcpSync, ENV_ENABLE_MCP, readMcpSettings } from "../src/mcp.ts";
import { ENV_BASE_URL } from "../src/provider.ts";

const ROOT = "https://llm.example.com";

describe("readMcpSettings", () => {
  it("is off by default and ignores unrelated settings", () => {
    assert.deepEqual(readMcpSettings(undefined, {}), { enabled: false, exposure: undefined });
    assert.deepEqual(readMcpSettings({ litellm: {} }, {}), { enabled: false, exposure: undefined });
    assert.deepEqual(readMcpSettings({ litellm: { mcp: "yes" } }, {}), {
      enabled: false,
      exposure: undefined,
    });
  });

  it("reads the settings block and drops invalid exposures", () => {
    assert.deepEqual(
      readMcpSettings({ litellm: { mcp: { enabled: true, exposure: "direct" } } }, {}),
      {
        enabled: true,
        exposure: "direct",
      },
    );
    assert.deepEqual(
      readMcpSettings({ litellm: { mcp: { enabled: true, exposure: "all" } } }, {}),
      {
        enabled: true,
        exposure: undefined,
      },
    );
    assert.equal(readMcpSettings({ litellm: { mcp: { enabled: "true" } } }, {}).enabled, false);
  });

  it("lets LITELLM_ENABLE_MCP override the block, blank defers", () => {
    const on = { litellm: { mcp: { enabled: true } } };
    assert.equal(readMcpSettings(on, { [ENV_ENABLE_MCP]: "0" }).enabled, false);
    assert.equal(readMcpSettings(on, { [ENV_ENABLE_MCP]: "false" }).enabled, false);
    assert.equal(readMcpSettings(on, { [ENV_ENABLE_MCP]: "  " }).enabled, true);
    assert.equal(readMcpSettings(undefined, { [ENV_ENABLE_MCP]: "1" }).enabled, true);
    assert.equal(readMcpSettings(undefined, { [ENV_ENABLE_MCP]: "TRUE" }).enabled, true);
    assert.equal(readMcpSettings(undefined, { [ENV_ENABLE_MCP]: "yes" }).enabled, false);
  });
});

describe("createMcpSync", () => {
  type Call = ["register", string, McpHttpServerConfig] | ["unregister", string];

  function harness(opts: { settings?: unknown; registerThrows?: string } = {}) {
    const calls: Call[] = [];
    let loaded = false;
    const pi = {
      getSettings() {
        if (!loaded) throw new Error("Extension runtime not initialized");
        return opts.settings ?? { litellm: { mcp: { enabled: true } } };
      },
      registerMcpServer(name: string, config: McpHttpServerConfig) {
        if (opts.registerThrows) throw new Error(opts.registerThrows);
        calls.push(["register", name, config]);
      },
      unregisterMcpServer(name: string) {
        calls.push(["unregister", name]);
      },
    };
    const notices: string[] = [];
    let auth: (() => Promise<unknown>) | undefined;
    const ctx = {
      hasUI: true,
      ui: { notify: (m: string) => notices.push(m) },
      modelRegistry: { getProviderAuth: () => auth!() },
    } as unknown as ExtensionContext;
    const mcp = createMcpSync(pi, {});
    return {
      calls,
      notices,
      mcp,
      ctx,
      markLoaded: () => (loaded = true),
      setAuth(root: string | undefined, key = "sk") {
        auth = async () =>
          root ? { auth: { apiKey: key }, env: { [ENV_BASE_URL]: root } } : undefined;
      },
      setAuthRejects() {
        auth = async () => {
          throw new Error("auth.json unreadable");
        };
      },
    };
  }

  it("does not read settings at load, registers once at first sync, no-op after", async () => {
    const h = harness();
    h.setAuth(ROOT);
    h.markLoaded();
    await h.mcp.sync(h.ctx);
    await h.mcp.sync(h.ctx);
    assert.deepEqual(h.calls, [
      [
        "register",
        "litellm",
        {
          url: `${ROOT}/mcp`,
          auth: { provider: "litellm" },
          description: "Tools served by the LiteLLM proxy",
        },
      ],
    ]);
  });

  it("passes a configured exposure through", async () => {
    const h = harness({ settings: { litellm: { mcp: { enabled: true, exposure: "deferred" } } } });
    h.setAuth(ROOT);
    h.markLoaded();
    await h.mcp.sync(h.ctx);
    assert.equal(h.calls[0]?.[2]?.exposure, "deferred");
  });

  it("never registers when disabled", async () => {
    const h = harness({ settings: {} });
    h.setAuth(ROOT);
    h.markLoaded();
    await h.mcp.sync(h.ctx);
    assert.deepEqual(h.calls, []);
  });

  it("keeps the registration when only the key changes, re-registers on a new root", async () => {
    const h = harness();
    h.markLoaded();
    h.setAuth(ROOT, "k1");
    await h.mcp.sync(h.ctx);
    h.setAuth(ROOT, "k2");
    await h.mcp.sync(h.ctx);
    assert.equal(h.calls.length, 1);
    h.setAuth("https://other.example.com/v1");
    await h.mcp.sync(h.ctx);
    assert.deepEqual(
      h.calls.map((c) => [c[0], c[2]?.url]),
      [
        ["register", `${ROOT}/mcp`],
        ["unregister", undefined],
        ["register", "https://other.example.com/mcp"],
      ],
    );
  });

  it("unregisters when auth disappears or cannot be resolved", async () => {
    const h = harness();
    h.markLoaded();
    h.setAuth(ROOT);
    await h.mcp.sync(h.ctx);
    h.setAuth(undefined);
    await h.mcp.sync(h.ctx);
    assert.deepEqual(
      h.calls.map((c) => c[0]),
      ["register", "unregister"],
    );

    h.setAuth(ROOT);
    await h.mcp.sync(h.ctx);
    h.setAuthRejects();
    await h.mcp.sync(h.ctx);
    assert.deepEqual(
      h.calls.map((c) => c[0]),
      ["register", "unregister", "register", "unregister"],
    );
    assert.deepEqual(h.notices, []);
  });

  it("reports a refused registration once, and retries only on a new root", async () => {
    const h = harness({ registerThrows: "name taken" });
    h.markLoaded();
    h.setAuth(ROOT);
    await h.mcp.sync(h.ctx);
    await h.mcp.sync(h.ctx);
    assert.deepEqual(h.notices, ["LiteLLM MCP: name taken"]);
    h.setAuth("https://other.example.com");
    await h.mcp.sync(h.ctx);
    assert.equal(h.notices.length, 2);
    // Nothing was ever registered, so nothing is unregistered.
    assert.deepEqual(h.calls, []);
  });

  it("drop() unregisters and the next sync registers again", async () => {
    const h = harness();
    h.markLoaded();
    h.setAuth(ROOT);
    await h.mcp.sync(h.ctx);
    h.mcp.drop();
    h.mcp.drop();
    await h.mcp.sync(h.ctx);
    assert.deepEqual(
      h.calls.map((c) => c[0]),
      ["register", "unregister", "register"],
    );
  });
});
