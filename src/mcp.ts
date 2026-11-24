/**
 * LiteLLM MCP bridge, opt-in.
 *
 * LiteLLM serves every MCP server a virtual key may reach as one streamable-HTTP
 * endpoint at `<root>/mcp`. This registers that endpoint as a pi MCP server named
 * `litellm`; pi's own MCP client connects, lists and calls the tools, and sends the
 * provider's current key itself (`auth: { provider }`). This file never sees the key.
 */

import type { ExtensionAPI, ExtensionContext, McpExposure } from "@earendil-works/pi-coding-agent";
import { normalizeBaseUrl } from "./discover.ts";
import { ENV_BASE_URL, PROVIDER_ID } from "./provider.ts";

export const ENV_ENABLE_MCP = "LITELLM_ENABLE_MCP";

const EXPOSURES: ReadonlySet<string> = new Set(["codemode", "deferred", "direct", "hidden"]);

export interface McpSettings {
  /** Default false: nothing is registered unless the user opts in. */
  enabled: boolean;
  /** Left to pi's default (`codemode`) when unset or invalid. */
  exposure?: McpExposure;
}

/**
 * `settings.json` block `{ "litellm": { "mcp": { "enabled", "exposure" } } }`.
 * `LITELLM_ENABLE_MCP` overrides `enabled`: `1`/`true` on, anything else off,
 * unset or blank defers to the block.
 */
export function readMcpSettings(
  settings: unknown,
  env: Record<string, string | undefined> = process.env,
): McpSettings {
  const litellm = (settings as { litellm?: unknown } | undefined)?.litellm;
  const block =
    litellm && typeof litellm === "object" ? (litellm as { mcp?: unknown }).mcp : undefined;
  const mcp = block && typeof block === "object" ? (block as Record<string, unknown>) : {};

  let enabled = mcp.enabled === true;
  const envValue = env[ENV_ENABLE_MCP]?.trim().toLowerCase();
  if (envValue) enabled = envValue === "1" || envValue === "true";

  const exposure =
    typeof mcp.exposure === "string" && EXPOSURES.has(mcp.exposure)
      ? (mcp.exposure as McpExposure)
      : undefined;
  return { enabled, exposure };
}

export interface McpSync {
  /** Register, re-register or unregister to match the current credential. Never throws. */
  sync(ctx: ExtensionContext): Promise<void>;
  /** Unregister now. Called when `/login` starts, before the new credential is stored. */
  drop(): void;
}

type SyncApi = Pick<ExtensionAPI, "registerMcpServer" | "unregisterMcpServer" | "getSettings">;

export function createMcpSync(pi: SyncApi, env?: Record<string, string | undefined>): McpSync {
  // Read lazily: pi.getSettings() throws while the extension is loading.
  let settings: McpSettings | undefined;
  // URL of the last attempt (registered or refused); undefined when nothing is registered.
  let attemptedUrl: string | undefined;
  let registered = false;

  function drop(): void {
    if (registered) pi.unregisterMcpServer(PROVIDER_ID);
    registered = false;
    attemptedUrl = undefined;
  }

  async function currentUrl(ctx: ExtensionContext): Promise<string | undefined> {
    try {
      const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
      const root = auth?.env?.[ENV_BASE_URL];
      if (!auth?.auth.apiKey || typeof root !== "string" || !root) return undefined;
      return `${normalizeBaseUrl(root)}/mcp`;
    } catch {
      return undefined;
    }
  }

  async function sync(ctx: ExtensionContext): Promise<void> {
    settings ??= readMcpSettings(pi.getSettings(), env);
    if (!settings.enabled) return;

    const url = await currentUrl(ctx);
    if (url === attemptedUrl) return;
    drop();
    if (!url) return;

    attemptedUrl = url;
    try {
      pi.registerMcpServer(PROVIDER_ID, {
        url,
        auth: { provider: PROVIDER_ID },
        description: "Tools served by the LiteLLM proxy",
        ...(settings.exposure ? { exposure: settings.exposure } : {}),
      });
      registered = true;
    } catch (error) {
      // attemptedUrl stays set: reported once, not on every turn.
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`LiteLLM MCP: ${message}`, "warning");
    }
  }

  return { sync, drop };
}
