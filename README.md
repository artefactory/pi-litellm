# pi-litellm

LiteLLM proxy provider for [pi](https://pi.dev). Internal Artefactory extension, written from
scratch and kept deliberately small (about 400 lines, no runtime dependencies).

- `/login litellm` stores the proxy URL and your API key in pi's `auth.json`.
- `/model` lists every chat model your key can reach on the proxy. `/scoped-models` works as usual.
- Each model is sent over the protocol its backend speaks natively: Claude over Anthropic
  Messages, OpenAI models over the Responses API, everything else over Chat Completions.
  Streaming is delegated to pi's built-in implementations; this extension contains no
  request or stream code.
- `/litellm-refresh` re-reads the proxy's catalog without logging in again.

## Install

```bash
pi install git:git@github.com:artefactory/pi-litellm
```

Then inside pi:

```
/login litellm
```

Enter the proxy root (for example `https://litellm.example.com`; a trailing `/v1` is fine and
is stripped) and your LiteLLM virtual key. Models appear in `/model` right after.

If you previously used `npm:pi-provider-litellm`, remove it first (`pi remove npm:pi-provider-litellm`):
both register the provider id `litellm`. Your existing credential in `auth.json` is reused as is.

### Without `/login` (CI, containers)

```bash
export LITELLM_BASE_URL="https://litellm.example.com"
export LITELLM_API_KEY="sk-..."
```

A stored `/login` credential takes precedence over the environment.

## How models are discovered

`GET /model/info` is read first. It carries limits, prices and capabilities, and LiteLLM
returns one entry per deployment; entries are collapsed by route name, taking the minimum
limits across deployments. Routes whose `mode` is not `chat` (embeddings, image generation,
audio) and LiteLLM auto-routers are skipped.

When the key may not read `/model/info` (401/403/404) or it is empty, `GET /v1/models` is
used instead. It has no metadata, so those models get a 128K context window, 16K output
limit, zero cost and Chat Completions transport.

The list is persisted by pi (`~/.pi/agent/models-store.json`) so startup works offline.
Cached models are shown only while the stored credential points at the proxy they came from.

## Transport selection

Decided from LiteLLM metadata, never from the alias name you chose on the proxy:

| Condition                                                                                                                                         | pi API               | Request path                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------- |
| `litellm_provider` is `anthropic`, `vertex_ai-anthropic_models`, `bedrock` or `bedrock_converse` **and** `litellm_params.model` contains `claude` | `anthropic-messages` | `<root>/v1/messages`         |
| `litellm_provider` is `openai` or `azure` **and** `supported_endpoints` lists `/v1/responses`                                                     | `openai-responses`   | `<root>/v1/responses`        |
| anything else                                                                                                                                     | `openai-completions` | `<root>/v1/chat/completions` |

A `null` `supported_endpoints` means LiteLLM has no model-map entry for that route, so it stays
on Chat Completions rather than guessing. Requests still go to your proxy with your virtual
key; the proxy's upstream credentials and budgets apply as for any other request.

## Limits

- One proxy, one credential, provider id `litellm`. No aliases.
- No SSO/OIDC login, MCP bridge, Skills injection, budget display, image or classifier models.
  The point of this extension is to not have those.
- Metadata is taken from the proxy as is. If a route advertises a `max_output_tokens` its
  backend rejects, fix it in the proxy config.

## Development

```bash
npm ci
npm run check   # tsc
npm test        # node:test via tsx
```

`scripts/smoke.ts` runs discovery and one short completion per transport against a real
proxy, through pi's own `ModelRuntime`. It needs an **isolated** agent dir holding a `litellm`
entry in `auth.json`:

```bash
PI_CODING_AGENT_DIR=/tmp/pi-test-agent npx tsx scripts/smoke.ts
```

To try the extension in pi without installing it: `pi -e /path/to/pi-litellm`.
