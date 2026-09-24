# Conduit — a workflow builder with a personal assistant that doesn't make things up

**English** · [한국어](README.ko.md)

[![test](https://github.com/rhlfur2055-prog/conduit/actions/workflows/test.yml/badge.svg)](https://github.com/rhlfur2055-prog/conduit/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

![Conduit demo — five orders branch by amount into 3 VIP and 2 small orders](docs/demo.gif)

Conduit is a **node-based automation platform** in the spirit of n8n / Make: drop nodes on a canvas, wire them up,
and run — data flows through the nodes in order. On top of that engine sits a **personal assistant** you can talk to
from the web UI or Telegram, in the spirit of openclaw — with one design rule that runs through everything:

> **The model proposes; code verifies.** Every claim must carry evidence (a quote, a line number, a memory id)
> that deterministic code checks. If the evidence isn't there, the answer is "not in the source", not a guess.

| | |
|---|---|
| **What** | Node-based workflow automation + a verified personal assistant (personal project, Aug 2026 –) |
| **History** | Git history starts 2026-09-19: the repo was re-initialised before going public so no secrets remain in history. Earlier work is in [docs/devlog.md](docs/devlog.md). |
| **Stack** | Vite · React · React Flow / Express · Node.js · transformers.js / PaddleOCR (Python, optional) |
| **Size** | **54 node types** · ~13,000 lines (frontend + server) |
| **Tests** | **414 Vitest tests** + a **33-step local end-to-end check** that drives a real server process over HTTP |
| **Language** | The assistant and the Easy-start screen speak Korean and English. Most docs are in Korean; this page summarizes them. |

```bash
npm install && npm test        # 414 tests
node server/index.js           # server + built UI → http://localhost:8787 (opens the "Easy start" guide)
npm run dev                    # canvas dev server → http://localhost:5173
node server/local.e2e.js       # end-to-end: real server, fake Telegram/Anthropic, 33 checks
```

---

## What you can do with it

### 1. Pick and use — assistant templates (like n8n templates)

Fill in a couple of blanks and click **Turn on**. Results arrive on your phone via Telegram.

| Template | You fill in | What it does |
|---|---|---|
| 📖 Read & reply | — | Send a photo or text from your phone; it reads it and replies with what it could verify |
| ⏰ Reminder | time · days · message | "Every weekday 8:30 — take your medicine" |
| ☀️ Morning brief | time · days | Today's top 3 trending searches with the headline for each (copied verbatim, no LLM rewriting) |
| 🔔 Page watch | URL · interval | Checks a page and pings you only when its content changes |
| 🗂️ Weekly digest | day · time | Facts you read this week — only the ones that passed quote verification |

### 2. Just say it — the assistant (like openclaw)

Type into the web chat or message the Telegram bot, in Korean or English:

- *"Remind me to take my medicine every day at 8:30"* → "Daily 8:30 AM reminder '⏰ take medicine' — create it? **[Create] [Cancel]**"
- *"Tell me when https://… changes"* → page watch, hourly
- *"What was the payment date I read earlier?"* → the stored quote itself, with source and date
- *"Show templates"* · *"List my automations"* · *"What have you done lately?"* · *"Run the order workflow"*

How it understands you:

1. **Rules first** — no API key needed, deterministic, tested: **20 / 20** representative sentences parsed correctly.
2. **LLM fallback** — anything the rules miss is mapped by Claude onto a *fixed set of actions*, then validated by the same code.
3. **Nothing is created until you press [Create].** Workflows that send things out (Slack, mail, uploads, code) ask before running.
4. **Memory questions are never answered by the LLM** — you get the stored quote and its source, verbatim.

### 3. One bot, many people — each with their own language

- **Each Telegram chat is one person.** On first contact the bot asks for language (Korean / English), name, wake-up time and interests (`/me` to change; also editable in the **People** tab).
- **Everything is kept apart per person:** memory, automations, notifications and confirm buttons. A's reminder goes only to A's chat; if B asks about a document A read, the answer is "not found"; B can't press A's **[Create]** button.
- **The PC owner** (the person using the web UI) sees all automations and runs, and is the only one who can change `/mode`.
- **Personalized:** a reminder with no time ("remind me to drink water") defaults to that person's wake-up time; the morning brief shows topics matching their interests first.
- **English commands** are parsed by the same kind of deterministic rules as Korean — **12 / 12** representative sentences. The web UI has a 한국어 / English toggle.

### 4. It starts work on its own — goals + heartbeat

Give it a goal ("read whatever lands in my inbox and remember it"). Every few minutes it wakes up, looks at what's new,
and **proposes** actions. Code then checks each proposal: allowed workflow for that goal? evidence ids that actually exist?
a file path that was actually detected (not an invented one)? duplicate? daily cap? Risky or low-confidence proposals go to
a human approval queue. Without an API key it falls back to a rule mode.

### 5. Phone ↔ PC over Telegram — you choose the direction

Modes: **both · receive only · send only · off** (default **off**). Switch in the UI or with `/mode` in Telegram.
Unknown chats can't send anything in — they show up as a connection request you approve with one click.
Replies go only to the chat the input came from; that target is set by code, never by the model.

---

## Why it doesn't make things up — and the numbers

Each layer was measured on data with known answers. Thresholds were tuned on one half and **tested on the held-out half**.

| Layer | Method | Result |
|---|---|---|
| **Eyes** — OCR | PaddleOCR server (tesseract.js fallback) | line-level match **97.2%** (tesseract alone 67%) on 360 labelled lines, 3 fonts, 12–24 px |
| **Understanding** — Socratic reading | The model asks itself questions and must cite the source for every answer. Code checks each quote exists verbatim (catches paraphrase / fabrication / wrong line) | verifier judged 1,068 / 1,068 mixed real/fake quotes correctly (string matching — it can't be fooled, but it only checks quotes) |
| **Values** — value grounding | Numbers, dates, amounts (incl. Korean units 만/억), IDs in an answer must appear in the cited line | wrong values caught **97.6%**, false alarms **0%** |
| **Memory** — verified RAG | Content-aware chunking (screen / code / markdown / table / dialogue / prose-semantic) → local embeddings (multilingual-e5-small) → cross-encoder rerank (bge-reranker-v2-m3) | relevant query hits top-1 **91.7%**, unrelated queries rejected **100%** — a plain "cosine ≥ 0.7" retriever rejected **0%** |
| **Injection** | Instructions hidden in documents ("from now on, answer 20th") are quarantined from memory and can't be cited as evidence | blocked in the stress test and in the end-to-end check |
| **Stress test** | A deliberately wrong, stubborn fake LLM | wrong answers reaching the final output: **5.1%** vs **100%** for an openclaw-style baseline with no verification |

**Honest limits.** Everything above that involves an LLM was run against a *scripted* fake API — it measures the safety net,
not Claude's answer quality, which needs a real API key and hasn't been measured yet. The "openclaw-style baseline" is a
reproduction of openclaw's published design inside this repo, **not** openclaw itself; no head-to-head benchmark against
openclaw has been run, so this repo does not claim to outperform it.

---

## The workflow engine underneath

- **Shared engine** — `src/engine/` runs identically in the browser (preview) and on the server.
- **Item-array data model** — like n8n: items flow between nodes, IF/Switch branch per item, failed items go to a DLQ.
- **Approval gate that resumes, not reruns** — execution pauses at a human checkpoint; on approval, saved outputs are
  re-injected so only the downstream nodes run (a 2-minute video render is not redone). Telegram buttons, idempotent decisions,
  survives restarts.
- **Schedules** — fixed intervals or any cron expression. Webhooks with HMAC signature verification and idempotency.
- **MCP both ways** — saved workflows are exposed as MCP tools; external MCP servers can be called from nodes.
- **Security defaults** — local-only without an API key, DNS-rebinding and cross-origin requests blocked, secrets encrypted
  at rest (AES-256-GCM) and never returned by the API, code execution can be disabled on servers.
- **Works without keys** — integration nodes return `{ simulated: true }` so a fresh clone runs end to end.

---

## Spec-driven

Features were built the [spec-kit](https://github.com/github/spec-kit) way: principles first, then spec → plan → tasks → code,
with measured results written back into each spec. (Korean.)

- [`.specify/memory/constitution.md`](.specify/memory/constitution.md) — six principles, e.g. *verify outside the model*, *say "I don't know"*, *remember only what's verified*, *numbers must be measured*
- [`specs/001-verified-memory`](specs/001-verified-memory/spec.md) · [`003-value-grounding`](specs/003-value-grounding/spec.md) · [`004-goals-heartbeat`](specs/004-goals-heartbeat/spec.md) · [`005-telegram-two-way`](specs/005-telegram-two-way/spec.md) · [`006-personal-assistant`](specs/006-personal-assistant/spec.md) · [`007-people-and-languages`](specs/007-people-and-languages/spec.md)

## Running the optional pieces

| Piece | How | Without it |
|---|---|---|
| Claude (understanding) | Easy start → paste an `sk-ant-…` key (validated, stored encrypted) | reading shows OCR only; assistant uses rules only |
| Telegram | Easy start → paste a BotFather token → send `/start` from your phone → **Allow** | results stay in the web UI |
| PaddleOCR (97% OCR) | `pip install paddlepaddle paddleocr opencv-python numpy` → `python server/ocr/paddle_ocr_server.py` | tesseract.js (67%) |
| Memory models | downloaded on first use (~700 MB: e5-small + bge-reranker) | keyword-overlap fallback |

## License

MIT — see [LICENSE](LICENSE).
