# Refusal classifier model

`classifyTurnResponse` (`packages/core/src/classifier.ts`) decides whether a tool-mode
turn that produced **no tool call** is a `REFUSAL` (→ forcing retry) or a
`DELIVERABLE`. It runs in-process, on CPU, via `@huggingface/transformers`.

## Two backends (tried in order)

1. **Local fine-tuned head (preferred)** — a ModernBERT sequence classifier with an
   **8k** context window (default: `natong19/refusal_classifier`, a `mBERT`/ModernBERT
   refusal head). It is **not published on the Hub with ONNX weights**, so it must be
   built locally and dropped in (below). Its refusal label is matched by
   `M365_CLASSIFIER_POSITIVE_LABEL`.
2. **Fallback** — the legacy zero-shot NLI (`Xenova/nli-deberta-v3-base`, 512-token),
   downloaded automatically. Used when the local head is absent, so a fresh host works
   out of the box.

On load the proxy logs which backend it chose; if the local head is missing it logs a
warning and falls back.

## Build the local head (safetensors → ONNX)

transformers.js only loads **ONNX** (in an `onnx/` subfolder); the source model ships
safetensors. Convert with 🤗 Optimum (CPU is fine — no GPU needed for a ≤400M encoder):

```sh
python3 -m venv /tmp/onnxenv
/tmp/onnxenv/bin/pip install --upgrade pip
/tmp/onnxenv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
/tmp/onnxenv/bin/pip install "optimum[onnxruntime]" "transformers>=4.48"

# ModernBERT needs opset >= 18 (opset 14 warns / may be suboptimal)
/tmp/onnxenv/bin/optimum-cli export onnx \
  --model natong19/refusal_classifier \
  --task text-classification \
  --opset 18 \
  /tmp/natong19-onnx
```

Then rearrange into the bundle layout transformers.js expects:

```
<bundle>/
  config.json               # from /tmp/natong19-onnx/  (carries id2label: 0 non-refusal, 1 refusal)
  tokenizer.json            # from /tmp/natong19-onnx/
  tokenizer_config.json     # from /tmp/natong19-onnx/
  special_tokens_map.json   # from /tmp/natong19-onnx/
  onnx/
    model.onnx              # from /tmp/natong19-onnx/model.onnx  (~1.2 GB, fp32)
```

`dtype: "fp32"` loads `onnx/model.onnx`; `dtype: "q8"` would look for
`onnx/model_quantized.onnx`. (Run `onnxruntime.quantization.quantize_dynamic` if you
want a smaller int8 head — but verify the corpus acceptance below after quantising.)

## Where to put it

`M365_CLASSIFIER_MODEL` (absolute path) overrides the location. Default:
`~/.config/opencode-m365/models/natong19` (i.e. the app config dir).

On the production host the proxy runs as **root** (`HOME=/root`), and the bundle lives
at `/opt/m365-copilot-proxy/models/natong19` — set via a systemd drop-in:

```ini
# /etc/systemd/system/m365-copilot-proxy.service.d/classifier.conf
[Service]
Environment="M365_CLASSIFIER_MODEL=/opt/m365-copilot-proxy/models/natong19"
```

The `models/` directory is git-ignored — the bundle is **never committed** (it's ~1.2 GB
and derived).

## Environment

| var | default | meaning |
|---|---|---|
| `M365_CLASSIFIER_MODEL` | `~/.config/opencode-m365/models/natong19` | bundle dir or Hub id |
| `M365_CLASSIFIER_POSITIVE_LABEL` | `^refus` | regex matching the head's refusal label (`refusal`, not `non-refusal`) |

## Acceptance suite

The corpora `refusals.txt` / `antirefusals.txt` are validated against the **classifier**
(not regex heuristics). Run the gated suite with the real model:

```sh
M365_CLASSIFIER_ACCEPTANCE=1 npx vitest run packages/core/src/classifier.test.ts
```

It asserts every `refusals.txt` entry is `REFUSAL` and **no** `antirefusals.txt` entry
is. Two tests that must pass: high refusal recall **and** zero deliverable false
positives (the false positives are what trigger the spurious "refusal detected → identical
retry" loop).
