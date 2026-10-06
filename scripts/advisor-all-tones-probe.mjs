#!/usr/bin/env node
// RE probe: test the advisor framing against all available M365 models/tones.
//
// Sends a single-turn coding task requiring a bash tool call to each model,
// with `x-m365-framing: advisor` header set to evaluate tool compliance,
// refusal avoidance, and response quality across models.
//
// Usage:
//   node scripts/advisor-all-tones-probe.mjs [--url http://10.0.1.15:4141] [--framing advisor] [--delay 15000]

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
};

const BASE_URL = getArg("--url", process.env.M365_PROXY_URL || "http://10.0.1.15:4141").replace(/\/+$/, "");
const FRAMING = getArg("--framing", "advisor");
const DELAY_MS = parseInt(getArg("--delay", "15000"), 10);
const MODELS_ARG = getArg("--models", null);

const DEFAULT_MODELS = [
  "gpt-6-astra",           // Tone: Gpt_6_Astra
  "gpt-5.6-think-deeper",  // Tone: Gpt_5_6_Reasoning
  "gpt-5.5-think-deeper",  // Tone: Gpt_5_5_Reasoning
  "gpt-5.5",               // Tone: Gpt_5_5_Chat
  "m365-copilot",          // Tone: magic
  "claude-sonnet",         // Tone: Claude_Sonnet
  "think-deeper",          // Tone: Gpt_Reasoning
  "quick",                 // Tone: Gpt_Quick
];

const MODELS = MODELS_ARG ? MODELS_ARG.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_MODELS;

const BASH_TOOL = {
  type: "function",
  function: {
    name: "bash",
    description: "Execute a shell command against the working directory.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command line to execute." },
      },
      required: ["command"],
    },
  },
};

const PROMPT = "Inspect the repository structure with `ls -la` and check what files are present in the current working directory.";

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = join(process.cwd(), "scripts", "advisor-probe-out", TS);
mkdirSync(OUT_DIR, { recursive: true });

console.log("=== M365 Copilot Advisor Framing Probe ===");
console.log(`Target Proxy:  ${BASE_URL}`);
console.log(`Framing Mode:  ${FRAMING}`);
console.log(`Turn Spacing:  ${DELAY_MS}ms`);
console.log(`Models (${MODELS.length}): ${MODELS.join(", ")}`);
console.log(`Output Dir:    ${OUT_DIR}\n`);

const results = [];

for (let i = 0; i < MODELS.length; i++) {
  const model = MODELS[i];
  console.log(`[${i + 1}/${MODELS.length}] Probing model: ${model} ...`);

  const t0 = Date.now();
  let status = 0;
  let data = null;
  let errorMsg = null;

  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-m365-framing": FRAMING,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: PROMPT }],
        tools: [BASH_TOOL],
        stream: false,
      }),
    });

    status = res.status;
    const bodyText = await res.text();
    try {
      data = JSON.parse(bodyText);
    } catch {
      errorMsg = bodyText.slice(0, 200);
    }
  } catch (err) {
    errorMsg = err.message;
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  const choice = data?.choices?.[0];
  const toolCalls = choice?.message?.tool_calls ?? [];
  const textContent = choice?.message?.content ?? "";
  const finishReason = choice?.finish_reason;
  const errorObj = data?.error;

  const hasToolCall = Array.isArray(toolCalls) && toolCalls.length > 0;
  const toolName = hasToolCall ? toolCalls[0].function?.name : null;
  let commandArg = "";
  if (hasToolCall) {
    try {
      const parsedArgs = JSON.parse(toolCalls[0].function?.arguments || "{}");
      commandArg = parsedArgs.command || JSON.stringify(parsedArgs);
    } catch {
      commandArg = toolCalls[0].function?.arguments || "";
    }
  }

  // Refusal detection heuristics
  const refusalPatterns = [
    /cannot\s+(?:run|execute|access)/i,
    /don'?t\s+have\s+(?:a\s+shell|access|tools)/i,
    /no\s+(?:shell|bash|tools?)/i,
    /unable\s+to/i,
    /apologize/i,
    /please\s+(?:run|paste)/i,
  ];
  const looksLikeRefusal = !hasToolCall && refusalPatterns.some((p) => p.test(textContent));

  const outcome = hasToolCall
    ? "TOOL_CALL"
    : errorObj
      ? `ERR_${errorObj.type || status}`
      : looksLikeRefusal
        ? "REFUSAL"
        : "PROSE";

  const row = {
    model,
    status,
    outcome,
    hasToolCall,
    toolName,
    command: commandArg.slice(0, 100),
    finishReason,
    textContent: textContent.slice(0, 150),
    error: errorObj?.message || errorMsg,
    elapsedSec: Number(elapsedSec),
  };
  results.push(row);

  const outcomeIcon = outcome === "TOOL_CALL" ? "✅" : outcome === "REFUSAL" ? "❌" : "⚠️";
  console.log(`   ${outcomeIcon} ${outcome} (${status}) in ${elapsedSec}s: ${hasToolCall ? `tool=${toolName} cmd=${JSON.stringify(commandArg.slice(0, 60))}` : (row.error || textContent.slice(0, 80))}`);

  if (i < MODELS.length - 1) {
    console.log(`   Pacing: sleeping ${DELAY_MS / 1000}s before next conversation...`);
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }
}

// Write JSON output
writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2));

// Print Scorecard
console.log("\n========================================================");
console.log(`=== SCORECARD: Advisor Framing Sweep across All Models ===`);
console.log("========================================================");
console.log("| Model | Outcome | Tool Called | Command | Latency | Status |");
console.log("|---|---|---|---|---|---|");
for (const r of results) {
  const toolStr = r.hasToolCall ? `\`${r.toolName}\`` : "-";
  const cmdStr = r.command ? `\`${r.command.replace(/`/g, "\\`")}\`` : (r.error ? `Err: ${r.error.slice(0, 30)}` : `"${r.textContent.replace(/\n/g, " ").slice(0, 30)}..."`);
  console.log(`| **${r.model}** | ${r.outcome === "TOOL_CALL" ? "✅ TOOL_CALL" : r.outcome === "REFUSAL" ? "❌ REFUSAL" : "⚠️ " + r.outcome} | ${toolStr} | ${cmdStr} | ${r.elapsedSec}s | HTTP ${r.status} |`);
}
console.log("========================================================\n");
console.log(`Full JSON saved to: ${join(OUT_DIR, "results.json")}`);
