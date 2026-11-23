/**
 * pi-litellm: LiteLLM proxy provider for pi.
 *
 *   /login litellm      store proxy URL + API key
 *   /model              pick any chat model the proxy exposes
 *   /litellm-refresh    re-discover models without logging in again
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLiteLLMProvider, PROVIDER_ID } from "./provider.ts";

export default function (pi: ExtensionAPI) {
  pi.registerProvider(createLiteLLMProvider());

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
