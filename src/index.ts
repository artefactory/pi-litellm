/**
 * pi-litellm: LiteLLM proxy provider for pi.
 *
 *   /login litellm      store proxy URL + API key
 *   /model              pick any chat model the proxy exposes
 *   /litellm-refresh    re-discover models without logging in again
 *   /mcp                the proxy's MCP tools, when enabled in settings (off by default)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpSync } from "./mcp.ts";
import { createLiteLLMProvider, PROVIDER_ID } from "./provider.ts";

export default function (pi: ExtensionAPI) {
  const mcp = createMcpSync(pi);
  pi.registerProvider(createLiteLLMProvider({ onLoginStart: mcp.drop }));

  // session_start covers startup; before_agent_start picks up a /login or /logout
  // that changed the proxy root. Handlers return nothing on purpose: a returned
  // object from before_agent_start would override the system prompt.
  pi.on("session_start", async (_event, ctx) => {
    await mcp.sync(ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    await mcp.sync(ctx);
  });

  pi.registerCommand("litellm-refresh", {
    description: "Re-discover models from the LiteLLM proxy",
    async handler(_args, ctx) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const result = await ctx.modelRegistry.refresh({
          providers: [PROVIDER_ID],
          allowNetwork: true,
          force: true,
          signal: controller.signal,
        });
        const error = result.errors.get(PROVIDER_ID);
        if (result.aborted) {
          ctx.ui.notify("LiteLLM refresh timed out; keeping cached models", "warning");
        } else if (error) {
          ctx.ui.notify(`LiteLLM refresh failed: ${error.message}`, "error");
        } else {
          const count = ctx.modelRegistry
            .getAvailable()
            .filter((m) => m.provider === PROVIDER_ID).length;
          ctx.ui.notify(`LiteLLM: ${count} model(s) available`, "info");
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
