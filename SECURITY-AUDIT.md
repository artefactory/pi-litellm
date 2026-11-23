# Security notes: pi-litellm

|                      |                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Origin               | Written in-house (Artefactory), not a fork. Surveyed `pi-provider-litellm` 4.9.0, `@odinlayer/pi-provider-litellm` 1.0.19, `@danmademe/pi-provider-litellm` 0.14.1 and `pi-litellm-hub` 0.1.2 for features; no code was copied. |
| Version              | `0.1.0`                                                                                                                                                                                                                         |
| Date                 | 2026-11-23                                                                                                                                                                                                                      |
| Reviewed by          | Sébastien Vallin, assisted by a Pi agent                                                                                                                                                                                        |
| Runtime dependencies | None. Peer: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` (supplied by pi).                                                                                                                                        |

This document is the reviewer-facing inventory that every merge to `main` must keep accurate.
A provider extension sees the API key, every prompt and every model response; the list below
is what it does with them.

## Inventory

| Capability                                               | Where                                                                                  | What it does                                                                                                                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network: `GET <root>/model/info`, `GET <root>/v1/models` | `src/discover.ts` `discoverModels`                                                     | Model discovery. `Authorization: Bearer <key>`. `redirect: "error"` so the key never follows a redirect to another host. 10 s timeout, honours pi's abort signal. Only the configured root is contacted. |
| Network: model requests                                  | pi-ai built-ins (`anthropicMessagesApi`, `openAIResponsesApi`, `openAICompletionsApi`) | This extension has no stream or request code. Each model's `baseUrl` is derived from the credential root at discovery time.                                                                              |
| Credential storage                                       | pi's `auth.json` via `ApiKeyAuth.login`                                                | `{ type: "api_key", key, env: { LITELLM_BASE_URL } }`. The extension never writes files itself.                                                                                                          |
| Credential read                                          | `ApiKeyAuth.resolve` / `check`                                                         | Stored key, else `LITELLM_API_KEY`. Root: stored, else `LITELLM_BASE_URL`.                                                                                                                               |
| Child processes                                          | none                                                                                   |                                                                                                                                                                                                          |
| File system                                              | none (pi persists the catalog in `models-store.json`)                                  |                                                                                                                                                                                                          |
| System prompt / tools / messages                         | none                                                                                   | No tools registered, no prompt injection, no message hooks.                                                                                                                                              |
| Commands                                                 | `/litellm-refresh`                                                                     | Calls `ctx.modelRegistry.refresh` for provider `litellm` only.                                                                                                                                           |
| Logging                                                  | none                                                                                   | Nothing is written to stdout/stderr. Login notifications show a model count only.                                                                                                                        |

## Guards

- **Key confinement.** `filterModels` hides any cached model whose `baseUrl` does not match the
  root of the current credential, so a catalog cached from proxy A is never offered (and the key
  for proxy B never sent) after switching proxies.
- **No `auth.baseUrl`.** pi would apply it to every model; the root travels in `env` instead,
  and per-model base URLs are fixed at discovery.
- **URL validation.** `normalizeBaseUrl` accepts `https://` only, except `http://` on
  loopback, and rejects embedded credentials, other schemes and relative input.
- **Metadata-driven transport.** `selectApi` reads `litellm_provider`, `litellm_params.model`
  and `supported_endpoints`; the operator-chosen alias is never used to pick a protocol.
- **Fail closed on discovery.** No key or root means `fetchModels` throws and nothing is listed;
  it never falls back to an unauthenticated request.

## Trust assumptions

- The LiteLLM proxy is trusted for the metadata it returns (limits, prices, capabilities) and
  for the content of model responses, exactly as with any provider.
- pi itself is trusted: credential storage, model persistence and streaming are pi's code.

## Review checklist for changes

- `src/**` or `package*.json` change → re-read this file, update the inventory, bump the version.
- Any new `fetch`, file access, child process, tool, command or hook → must appear in the inventory.
- A dependency added → justify here; the default answer is no.
- Run `npm run check && npm test`, and `scripts/smoke.ts` against a real proxy for transport changes.
