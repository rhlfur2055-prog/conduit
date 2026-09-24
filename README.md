# Conduit — automation where the AI drafts, a human approves, and code verifies

**English** · [한국어](README.ko.md)

[![test](https://github.com/rhlfur2055-prog/conduit/actions/workflows/test.yml/badge.svg)](https://github.com/rhlfur2055-prog/conduit/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

![Conduit demo — five orders branch by amount into 3 VIP and 2 small orders](docs/demo.gif)

Conduit is a **node-based workflow engine** (in the spirit of n8n / Make) built around one question companies ask
before letting AI touch customers: *what stops it from sending the wrong thing?*

The answer runs through the whole codebase:

> **The AI proposes. A human approves. Code verifies.**
> An LLM may draft a reply or suggest an action, but nothing goes out until a person presses a button,
> and every claim must carry evidence that deterministic code checks.

| | |
|---|---|
| **What** | Workflow engine with a human-approval gate, a verification layer for LLM output, and MCP in both directions (personal project, Aug 2026 –) |
| **Stack** | TypeScript (engine core, strict) · JavaScript (server, UI) / Node.js · Express / React · React Flow · Vite / Docker · GitHub Actions |
| **Size** | ~11,000 lines (engine + server + UI) · 45 node types |
| **Tests** | **442 Vitest tests** (incl. one that SIGKILLs a real server mid-resume and restarts it) + a **33-step end-to-end check** over HTTP |
| **Brain** | **No API key required.** If [Ollama](https://ollama.com) is running, Conduit uses the model on your PC and nothing leaves your machine. Add a Claude key only if you want it. |
| **History** | Git history starts 2026-09-19: the repo was re-initialised before going public so no secrets remain. Earlier work is in [docs/devlog.md](docs/devlog.md). |

**Try it without installing:** [rhlfur2055-prog.github.io/conduit](https://rhlfur2055-prog.github.io/conduit/) — the canvas runs the engine in your browser; integration nodes simulate.

```bash
npm install && npm test        # 442 tests, no keys needed
node server/index.js           # server + built UI → http://localhost:8787
node server/local.e2e.js       # end-to-end: real server, fake Telegram/Anthropic, 33 checks
```

Runs end to end without any API key: integration nodes return `{ simulated: true }`, so a fresh clone works on the first try.
For real answers without a key: install Ollama, run `ollama pull gemma3:4b`, start Conduit. It finds the model by itself.

---

## 1. Approval gate — pause, approve, resume (not rerun)

The AI writes the draft. Sending waits for a human. On approval, **only the downstream nodes run**.

```
run 1:  inquiry webhook → AI reply draft → [waiting for approval] ⏸     status = waiting
                                              ↓ one Telegram button (✅ approve · ✏️ edit · ❌ reject)
run 2:  saved outputs injected as seed → upstream skipped → send only ▶
```

Resume log — `●` is *injected*, `✔` is *executed*:

```
● inquiry webhook — 1 item injected        ← not called again
● AI reply draft  — 1 item injected        ← no second LLM call
✔ send to customer — 1 in → 1 out          ← only what was approved
⤵ reject handler   — skipped (no input)
```

**Approval by policy, not by wiring.** Placing an approval node is a choice, and a forgotten node means an AI draft goes out unreviewed. So the engine also enforces it: if a *sending* node (Telegram, Slack, Gmail, Notion, non-GET HTTP, MCP tool call) is reachable from a *model-output* node (AI, extract, agent, Socratic reading, screen understanding) with no approval node in between, the run **stops in front of the send and asks a human** — same buttons, same resume, same crash safety. The decision is made on the graph, not on data, so a code node that strips fields cannot slip past it, and `POST /api/workflows/lint` reports unguarded paths before you save. Default on; `CONDUIT_AI_GATE=off` disables it (turning it off has to be explicit).

Design decisions that make this safe rather than merely convenient:

- **Two-phase pause.** While the node runs, only a record exists (`preparing`). The snapshot is committed and the message sent *after* execution finishes (`pending`). No button can be pressed mid-run, and no node runs twice on resume.
- **Everything below the gate is skipped**, so multi-input nodes (Merge) never run on half their inputs. Unrelated branches keep flowing.
- **Idempotent decisions.** A decision is one `UPDATE … WHERE status = 'pending'` — a compare-and-set the database performs, so two presses (or two processes) resume once. The same statement records that the resume has started, so there is no gap between "decided" and "resuming" for a crash to fall into. If resume fails, the user sees "approved but failed" with a 🔁 retry button.
- **Survives restarts.** Waiting runs and decisions live in SQLite; a run that died mid-resume is found and reported at startup, and 🔁 retry resumes it. Proven by a test that **SIGKILLs a real server process in the middle of a resume** and restarts it on the same data directory (`tests/server/crash.test.js`).
- **Never passes silently.** No channel or a failed send raises a node error instead of behaving as if approved.

| | |
|---|---|
| Node | `approvalRequest` — approved / rejected / expired ports · one reminder · expiry |
| Policy | `src/engine/gates.ts` — unguarded AI→send paths become an automatic gate at run time; `POST /api/workflows/lint` lists them at design time |
| Channel | Telegram buttons, long-polling (no public URL), only the originating chat's decision is accepted |
| API | `GET /api/approvals` · `POST /api/approvals/:id/decide` (API-key auth) |
| Extend | another channel is one adapter (`setApprovalAdapter`) |
| Code | `server/approvals.js` · `server/telegram.js` · `src/engine/executor.ts` (waiting state) |

---

## 2. The model proposes, code verifies — with measured numbers

Everything the LLM says must cite evidence (a quote, a line number, a memory id) that code checks.
If the evidence isn't there, the answer is "not in the source", not a guess.

Each layer was measured on data with known answers; thresholds were tuned on one half and **tested on the held-out half**.

| Layer | Method | Result |
|---|---|---|
| **Eyes** — OCR | PaddleOCR server (tesseract.js fallback) | line-level match **97.2%** (tesseract alone 67%) on 360 labelled lines |
| **Understanding** — Socratic reading | The model must cite the source for every answer; code checks each quote exists verbatim | 1,068 / 1,068 real/fake quotes judged correctly (string match — cannot be fooled, only checks quotes) |
| **Values** — value grounding | Numbers, dates, amounts (incl. Korean units 만/억), IDs must appear in the cited line | wrong values caught **97.6%**, false alarms **0%** |
| **Memory** — verified RAG | Content-aware chunking → local embeddings (multilingual-e5-small) → cross-encoder rerank (bge-reranker-v2-m3) | top-1 **91.7%**, unrelated queries rejected **100%** (a plain "cosine ≥ 0.7" retriever rejected 0%) |
| **Injection** | Instructions hidden in documents are quarantined from memory and can't be cited as evidence | blocked in the stress test and in the end-to-end check |
| **Stress test** | A deliberately wrong, stubborn fake LLM | wrong answers reaching output: **5.1%** vs **100%** for a no-verification baseline |

**Honest limits.** Every LLM-involving number above was run against a *scripted* fake API — it measures the safety net,
not Claude's answer quality, which hasn't been measured. The "no-verification baseline" is a reproduction of openclaw's
published design inside this repo, **not** openclaw itself; no head-to-head benchmark was run.

Specs with the measurements written back: [`.specify/memory/constitution.md`](.specify/memory/constitution.md) ·
[`specs/001`](specs/001-verified-memory/spec.md) · [`003`](specs/003-value-grounding/spec.md) · [`004`](specs/004-goals-heartbeat/spec.md) ·
[`005`](specs/005-telegram-two-way/spec.md) · [`006`](specs/006-personal-assistant/spec.md) · [`007`](specs/007-people-and-languages/spec.md)

---

## 3. Engine reliability

- **One engine, two runtimes** — `src/engine/` runs identically in the browser (preview) and on the server. Server-only capabilities (LLM, integrations, agent) are injected through a bridge; the browser gets simulated responses.
- **Item-array data model** — like n8n: items flow between nodes, plain nodes handle one item and the engine loops, IF/Switch branch per item, failed items go to a **dead-letter queue** instead of killing the run.
- **Retry with exponential backoff**, Continue-On-Fail, Error Trigger.
- **Idempotency** — webhook keys are a `PRIMARY KEY` in SQLite and a claim is a single upsert, so the same request twice runs once even under concurrency (100 simultaneous claims → 1 winner, tested).
- **Operational records in SQLite** (built-in `node:sqlite`, no native dependency): approvals, idempotency keys, dead letters, executions — the records that must survive a crash and reject duplicates. Configuration (workflows, credentials, people) stays in JSON files because it is small and human-editable. Legacy JSON records migrate on first start.
- **Webhooks with HMAC signature verification** (Slack / GitHub / Stripe style), cron and interval schedules.
- **Security defaults** — API-key auth with `timingSafeEqual` (local-only when no key is set), DNS-rebinding and cross-origin blocked, secrets encrypted at rest (AES-256-GCM) and never returned by the API, code execution can be disabled on servers.
- **Ops** — GitHub Actions on every push, single-container Docker.
- **Work queue, not request handlers** — webhooks and cron ticks are *enqueued* (SQLite `jobs` table) and a worker runs them: the worker inside the server by default, or any number of `node server/worker.js` processes sharing the same database. "Take the next job" is one `UPDATE … RETURNING` with a lease, so two workers never take the same job; a worker that dies stops renewing its lease and another worker takes the job over (at-least-once — which is why sends sit behind the approval gate and triggers carry idempotency keys). A cron tick is keyed by the minute, so two servers firing the same schedule produce one job. Proven by tests that spawn two real worker processes over 30 jobs (every job ran exactly once) and SIGKILL a worker mid-job (the other finishes it, `attempts: 2`, one execution record).
- **Trace one run end to end** — every execution gets its id *before* it runs, so the approvals it raises and the dead letters it isolates hang off it. `GET /api/executions/:id/trace` returns, per node: status, attempts (retries included), time, items in → out, whether it was *injected* from a snapshot rather than executed; plus the approvals this run raised (gate type, decision, who, when, resume result → link to the resumed run), which approval this run was the resume of, and the isolated failures. The executions panel renders it, so "why did this go out?" is answered by clicking, not by reading logs.

Bugs the test suite found while being written (the reason it exists):

- The dedupe node compared nested objects wrongly — `{u:{id:1}}` and `{u:{id:2}}` were treated as equal (a `JSON.stringify` replacer array applied the same key list at every depth).
- A string made of two expressions only, `"{{ a }} {{ b }}"`, evaluated to `undefined` (the single-expression regex matched both as one).

Details: [Reliability & security](docs/reliability.md) · [Architecture](docs/architecture.md)

---

## 4. MCP in both directions

- **Workflows become Claude tools.** Register the server as an MCP server and every saved workflow is exposed as `run_<id>`; "run the order workflow" executes it and returns the result.
- **Nodes call external MCP servers** (stdio) from workflows and from the agent node.
- Published as an npm package: `packages/conduit-workflows-mcp` (official SDK, e2e tests, registry validation).

[MCP guide](docs/mcp.md)

---

## What ships on top: a verified personal assistant

The layers above were built for a concrete user: an assistant you talk to from the web UI or Telegram.

- **Templates** — read & reply, reminder, morning brief, page watch, weekly digest. Fill in a blank, press **Turn on**.
- **Say it** — "remind me every day at 8:30 to take my medicine" → **[Create] [Cancel]**. Rules first (no key, 20/20 test sentences), LLM fallback mapped onto a fixed action set, nothing created until you press the button.
- **Goals + heartbeat** — the assistant proposes actions on its own; code checks each proposal (allowed workflow? real evidence ids? real file path? duplicate? daily cap?) and routes risky ones to the approval queue.
- **One person per Telegram chat** — memory, automations, notifications and buttons are isolated per person; Korean and English.
- **Phone ↔ PC modes** — both · receive only · send only · off (default off). Unknown chats become a connection request you approve.

Screen reading uses two layers: `ocr` (tesseract.js, offline, no key) and `screenUnderstand` (Claude vision, key optional — without it the OCR result still flows).

---

## 5. Bring your own brain — no key required

Most people hesitate to paste an API key into a hobby tool. So the key is optional.

| Order | Provider | When |
|---|---|---|
| 1 | Claude (Anthropic) | a key is set in `.env` or in the UI |
| 2 | Any OpenAI-compatible server | `CONDUIT_LLM_BASE_URL` is set (LM Studio, llama.cpp, vLLM, a company gateway) |
| 3 | Ollama on this PC | nothing is configured but `localhost:11434` answers — **automatic** |
| 4 | Simulation | none of the above; nodes still run and say so |

- One switch in the Easy-start screen: **Model on my PC** (no key, nothing leaves your computer) or **Claude**.
- Ollama is called through its native API so reasoning models keep their "thinking" out of the answer; images go through as well (screen understanding, Socratic reading).
- **The verification layer does not care which model answered.** Quote checks, value grounding and injection quarantine are code, so a weaker local model gets caught the same way. That is the point of this repo.
- Honest limit: the agent node (tool calling) is still Claude-only. In local mode it says so instead of pretending.
- Measured on this machine (RTX 5070 laptop, `gemma3:4b`, 2026-09-24): an AI node answers a one-line Korean question in about 8 s on the first call (model load) and under 1 s after that. A reasoning model such as `qwen3:4b` spent its whole 1,024-token budget thinking and returned an empty answer after 48 s, so Conduit prefers non-reasoning models when it auto-selects. A 4B model is not Claude: it still gets facts wrong, which is exactly what the verification layer is there to catch.

`docker compose --profile local up -d` starts Conduit **and** Ollama together and pulls the model on first boot.

## Optional pieces

| Piece | How | Without it |
|---|---|---|
| Claude | Easy start → paste an `sk-ant-…` key (validated, stored encrypted) | assistant uses rules only; reading shows OCR only |
| Telegram | Easy start → BotFather token → `/start` from your phone → **Allow** | results stay in the web UI |
| PaddleOCR | `pip install paddlepaddle paddleocr opencv-python numpy` → `python server/ocr/paddle_ocr_server.py` | tesseract.js (67%) |
| Memory models | downloaded on first use (~700 MB) | keyword-overlap fallback |

## Docs

[Architecture](docs/architecture.md) · [Node catalog](docs/nodes.md) · [Reliability & security](docs/reliability.md) ·
[MCP](docs/mcp.md) · [AI node evals](docs/evals.md) · [Running](docs/running.md) · [Devlog](docs/devlog.md) ·
Blog: [Six design decisions from building an n8n](docs/blog/2026-09-n8n-design-decisions.md) (Korean)

## License

MIT — see [LICENSE](LICENSE).
