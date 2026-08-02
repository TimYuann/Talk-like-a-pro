# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — but while the version is `0.x.y`, any `minor` bump may break behavior.

## [v0.1.0] - 2026-08-01

First release — minimal usable version: vague request in, precise prompt out.

### Added

- **Vague-request detection**: heuristic prefilter (fuzzy verbs / short inputs) + force prefixes (`/!!` translate, `/!` pass through)
- **Context probe**: cwd, `git status --short`, `AGENTS.md`/`CLAUDE.md` head, last 6 session entries
- **LLM intent analysis** (per-model effort): judges clarity, produces a refined prompt or 1–3 clarifying questions
- **Multi-turn Q&A**: `ctx.ui.select` options + free-text input, then re-synthesis into the final prompt
- **TUI settings** (`/talk-like-a-pro`): enable switch, detail level (1 入门 / 2 标准), analyzer model picker, effort (filtered per model's supported thinking levels)
- **Effort safety net**: unsupported effort falls back by priority (`high` > `max` > … > `off`); empty output auto-retries one level higher
- **Bilingual README** (English + 简体中文 with switcher)

### Fixed

- Model picker crash: `SelectList` theme now follows the official pi-tui contract (`selectedText`/`description`/`scrollInfo`/`noMatch`/`selectedPrefix`, `onSelect`/`onCancel` props)
- `deepseek-v4-flash` returns empty content at `off` effort — handled by the effort safety net
- Analyzer model could not be resolved when `scopedModels` is empty (no scoping configured) — now falls back to registry models with configured auth
- JSON parse reliability: `maxTokens` cap (1500), `refinedPrompt` ≤500 chars constraint, and parse-retry that feeds the broken output back to the LLM for repair
