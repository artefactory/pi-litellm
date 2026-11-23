/**
 * Manual smoke test against a real LiteLLM proxy, through pi's own ModelRuntime.
 *
 *   PI_CODING_AGENT_DIR=/tmp/pi-test-agent npx tsx scripts/smoke.ts [model-id ...]
 *
 * Needs a `litellm` credential in <agentDir>/auth.json (run `/login litellm` in pi, or
 * copy the entry). Forces a network discovery, prints the persisted catalog, then sends
 * one short prompt to each given model id (default: one per transport, if present).
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createLiteLLMProvider, PROVIDER_ID } from "../src/provider.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) {
  console.error("Set PI_CODING_AGENT_DIR to an isolated agent dir (never your real one).");
  process.exit(2);
}

const runtime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
});
runtime.registerNativeProvider(createLiteLLMProvider());

const signal = AbortSignal.timeout(30_000);
const result = await runtime.refresh({
  providers: [PROVIDER_ID],
  allowNetwork: true,
  force: true,
  signal,
});
if (result.errors.size > 0) {
  for (const [id, error] of result.errors) console.error(`refresh error for ${id}:`, error.message);
  process.exit(1);
}

const store = JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8")) as {
  litellm?: { models: Array<Record<string, unknown>>; checkedAt?: number };
};
const persisted = store.litellm?.models ?? [];
console.log(
  `persisted ${persisted.length} model(s), checkedAt ${store.litellm?.checkedAt ? new Date(store.litellm.checkedAt).toISOString() : "-"}`,
);

const available = await runtime.getAvailable(PROVIDER_ID);
console.log(`available ${available.length} model(s):`);
for (const m of available) {
  const root = m.baseUrl.replace(/^https?:\/\/[^/]+/, "<root>");
  console.log(
    `  ${m.id.padEnd(30)} ${m.api.padEnd(20)} ${root.padEnd(10)} ${m.reasoning ? "R" : "-"}${m.input.includes("image") ? "V" : "-"} ctx=${m.contextWindow} out=${m.maxTokens} $${m.cost.input}/${m.cost.output}`,
  );
}

const requested = process.argv.slice(2);
const targets =
  requested.length > 0
    ? requested
    : (["anthropic-messages", "openai-responses", "openai-completions"] as const)
        .map((api) => available.find((m) => m.api === api)?.id)
        .filter((id): id is string => !!id);

for (const id of targets) {
  const model = available.find((m) => m.id === id);
  if (!model) {
    console.log(`\n${id}: not available`);
    continue;
  }
  process.stdout.write(`\n${id} via ${model.api}: `);
  const message = await runtime.completeSimple(
    model,
    {
      messages: [
        { role: "user", content: `Reply with exactly: OK from ${id}`, timestamp: Date.now() },
      ],
    },
    { signal: AbortSignal.timeout(60_000), maxTokens: 512 },
  );
  if (message.stopReason === "stop") {
    const text = message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    console.log(
      `${text.trim()}  [in=${message.usage.input} out=${message.usage.output} cost=$${message.usage.cost.total.toFixed(5)}]`,
    );
  } else {
    console.log(`${message.stopReason}: ${message.errorMessage}`);
  }
}
