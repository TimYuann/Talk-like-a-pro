# Talk like a Pro

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![中文](https://img.shields.io/badge/简体中文-README-blue.svg)](README.zh-CN.md)

> Vague request in, precise prompt out.
> 模糊需求进，精确 prompt 出。不打扰，不阻塞，必要时问你几个问题。

Pi extension that detects vague user requests, explores the project context, asks clarifying questions when needed, and produces a refined prompt for the coding agent.

## What it does

When the user types something like `帮我弄一下 auth` or `修一下 login bug`:

1. **Heuristic filter** — short / vague-verb inputs are candidates; specific paths / concrete verbs skip translation
2. **Context probe** — collects `cwd`, `git status --short`, `AGENTS.md` / `CLAUDE.md`, last 6 session entries
3. **LLM intent analysis** — calls the configured analyzer model (effort-aware) to judge clarity and either produce a refined prompt or generate clarifying questions
4. **Multi-turn Q&A** (when ambiguous) — `ctx.ui.select` for options + `ctx.ui.input` for free text
5. **Re-synthesis** — second LLM call with the user's answers to produce the final refined prompt
6. **Transform** — the refined prompt replaces the original input; the coding agent never sees the vague version

Failure paths (LLM error, parse failure, user cancel) all fall back to `pass through` so the user is never blocked.

## Settings (TUI)

```
/talk-like-a-pro               → open the settings UI
/talk-like-a-pro on|off|status
/talk-like-a-pro level 1|2|3   (beginner|standard|expert / 入门|标准|专家)
/talk-like-a-pro model <provider/id> | follow-current
/talk-like-a-pro effort <off|minimal|low|medium|high|max>
```

| Setting | Values | Default | Effect |
|---|---|---|---|
| Enable | on / off | **on** | Master switch; `/!!` still forces translation when off |
| Level | 1 入门 / 2 标准 | 2 | Refined-prompt output style (see below) |
| Analyzer model | follow-current / available models | follow-current | Which model runs the intent analysis |
| Effort | model-supported list | minimal | `reasoningEffort` for the analyzer call, filtered per model |

Config persists to `~/.pi/agent/extensions/talk-like-a-pro.json`. While enabled, the footer shows a `● TLAP Lx` status indicator.

Level differences (in `LEVEL_PROMPT_BLOCKS`) — the two levels differ in the **final artifact**, not in how they handle the conversation:

- **1 入门 (Beginner)** — produces a *complete task spec* (保姆级任务书): one-line intent + implied needs + 4+ concrete requirements including boundaries/non-goals + context (files, conventions, user background assumption) + 3+ verifiable acceptance criteria. Up to 3 plain-language clarifying questions.
- **2 标准 (Standard)** — produces an *efficient fill-in prompt* (高效补充式): one-line intent + 2–3 concrete requirements + context + 2 acceptance criteria. Only fills what the raw request lacks. 1–3 clarifying questions.

The analyzer model picker lists the current session's scoped models, or (when no scoping is configured) the models with configured credentials from the registry. Effort options always follow the analyzer model's supported thinking levels (e.g. a model with only `high`/`max` shows only those); if the stored effort is unsupported by the chosen model it is auto-corrected on selection.

## Control prefixes

| Prefix | Behavior |
|---|---|
| `/!! xxx` | Force translation (bypasses heuristic **and** the master switch) |
| `/! xxx` | Force skip (strips prefix, passes through) |
| (no prefix) | Heuristic decides (when enabled) |

Heuristic rules: enters translator when the input contains vague verbs (`弄/搞/整/修一下/加个/...`) or is shorter than ~15 chars without a specific target (file path, function name, etc.). Longer inputs with concrete targets pass through unchanged.

## Effort safety net

Reasoning models sometimes return empty content at low effort (e.g. `deepseek-v4-flash` returns nothing at `off`). The analyzer:

- falls back to a sane effort (`high` > `max` > … > `off`) when the configured value is unsupported by the analyzer model
- retries once at a higher effort when the model returns an empty response

## Install

### Development (this repo, recommended)

The repo entry is symlinked into the pi auto-discovery directory:

```bash
ls -la ~/.pi/agent/extensions/translator.ts
# -> <this-repo>/extensions/translator.ts (symlink)
```

Edit `extensions/translator.ts`, then `/reload` in pi.

### Standalone install

```bash
pi install git:github.com/TimYuann/Talk-like-a-pro
```

## Project layout

```
Talk-like-a-pro/
├── extensions/
│   └── translator.ts   # sole source file
├── package.json        # pi-package manifest
├── README.md           # this file (English)
├── README.zh-CN.md     # 中文版
├── CHANGELOG.md        # release notes
├── CONTRIBUTING.md     # dev workflow / commit & release conventions
├── LICENSE             # MIT
└── .gitignore
```

## Known limits

- `ctx.ui.select` doesn't render option descriptions; the LLM is told to make labels self-contained
- Multi-turn Q&A has no "skip all" button — each question is answered or cancelled individually
- Re-synthesis always triggers a second LLM call after Q&A; can be slow on large models
- The settings UI requires TUI mode; in non-TUI modes use the slash-command arguments
- The analyzer model list comes from the current session's scoped models; a model configured in one session may not be available in another (falls back to the current model)

## Tuning

The analyzer prompt and refined-prompt templates live in `extensions/translator.ts`:

- `buildAnalyzerPrompt(context, userInput, previousAnswers, level)` — assembles the prompt; per-level behavior lives in `LEVEL_PROMPT_BLOCKS` (1 入门 / 2 标准)
- `parseAnalysis()` — JSON parser; tolerates markdown fences and surrounding prose
- `callAnalyzer()` / `safeAnalyze()` — LLM call + empty-output retry + retry-on-parse-fail + error surfacing
- `resolveAnalyzerModel()` / `supportedEfforts()` — analyzer model resolution and per-model effort filtering
- `pickFallbackEffort()` — fallback priority when the configured effort is unsupported

To change the default config (master switch, level, model, effort), edit `DEFAULT_CONFIG`.
