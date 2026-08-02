---
obsidian-note-type: agents-md
target: coding-agent
cwd: <repo root>
updated: 2026-08-01
related:
  - ./README.md
---

# Talk like a Pro · Agent Bootstrap

A Pi extension that refines vague user requests into complete prompts for the coding agent. Single-file codebase (~400 lines). Loaded by pi via symlink during development.

## Read First

只需冷启动读取本文件。

## Routing

| 内容 | 位置 |
|---|---|
| 源码 | `extensions/translator.ts` |
| 用户文档 | `README.md` |
| 包元数据 | `package.json` |

只有一个源文件，无需再分目录。

## 操作日志（Operation Log）

**任何 review 或修改——不论是人类、AI agent、subagent——都必须在本仓库根目录的 `ACTIVE_STATES` 文件里追加一行记录。**

格式约定：

- `[YYYY-MM-DD] TYPE: <一句话要点>`
- `TYPE` ∈ {REVIEW, FIX, REFACTOR, FEATURE, DOCS, CHORE}
- 一行一条，无空行，无 markdown 表格
- 不修改、不删除既有行（除非确实是错的）
- 文件随时间追加，保留为可 grep 的纯文本流

## Core file responsibilities

- `extensions/translator.ts`：全部行为。单文件，无 build step（pi 通过 jiti 直接加载 TS）。
- `package.json`：`pi-package` 标识 + `pi.extensions` 字段；不要在这里加 build / lint 脚本，除非真的需要。
- `README.md`：给最终用户看的功能/安装/限制说明。不要写开发流程。
- `AGENTS.md`：本文件，给 agent 看。

## Engineering Discipline (本地约束)

- 求解最小问题：只动 translator.ts；不要新增配置文件层 / 选项系统 / 配置加载器，除非用户明确要。
- 每次改动后跑 `bun build --target=node --external '@earendil-works/*' extensions/translator.ts --outfile=/tmp/check.js` 做 syntax 烟囱测试；bundled 不报错即可。
- 改完不要 commit / 不要 publish；只动工作区文件。
- 改 prompt 模板（`buildAnalyzerPrompt` / `parseAnalysis`）时，必须同时更新 README 里"Known limits"和"Tuning"两节的相关描述。
- LLM 调用参数：`reasoningEffort: "minimal"`、`cacheRetention: "none"`、新 `uuidv7()` sessionId。改这三个之前先想清楚为什么。
- 兜底策略不变：失败 → pass through，不打扰用户。

## Verification

每次改动后：

1. `bun build` 通过（无 TS / import 错误）
2. `/reload` 后触发一次模糊输入，验证 refinedPrompt 输出符合模板
3. 故意制造一次 LLM 失败（断网 / 换无效 key），验证 `safeAnalyze` 把错误显示到 UI 而不 crash
4. 测试 `/!!` 强制翻译 + `/!` 强制 pass through

## Local boundaries

- 这是个单文件 extension；不要把它拆成多模块 / 不要加 src/ 子目录。除非行数超过 ~800。
- 不要加测试框架（vitest / jest 等），除非用户明确要求。pi 的 extension 传统是单文件可跑。
- 不要碰 `~/.pi/agent/extensions/translator.ts` —— 它是符号链接，由本仓库的源文件决定。