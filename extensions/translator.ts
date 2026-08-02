/**
 * Talk like a Pro
 *
 * 自动检测用户的"模糊需求"，探索上下文、分析意图：
 * - 清楚 → 直接产出标准/完整 prompt，注入 LLM
 * - 不清楚 → 多轮问答理清意图，再产出完整 prompt，注入 LLM
 *
 * v2: 新增 TUI 设置界面（/talk-like-a-pro 命令）：
 * - 启用开关、翻译层级（1 入门 / 2 标准）、分析模型、思考强度
 * - 配置持久化到 ~/.pi/agent/extensions/talk-like-a-pro.json
 *
 * 控制前缀：
 * - `/!! xxx` 强制翻译（绕过启发式和总开关）
 * - `/! xxx`  强制不翻译（剥离前缀后 pass through）
 *
 * 状态通知：通过 ctx.ui.notify 显示 Talk like a Pro 在干什么
 */

import { complete, getSupportedThinkingLevels, uuidv7 } from "@earendil-works/pi-ai/compat";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// 持久化配置（全局偏好，JSON 存于 ~/.pi/agent/extensions/）
// ============================================================================

const CONFIG_PATH = join(homedir(), ".pi/agent/extensions/talk-like-a-pro.json");

interface TLAPConfig {
	/** 总开关：false 时对所有输入 pass through（/!! 除外）。 */
	enabled: boolean;
	/** 翻译层级：1 入门 / 2 标准。 */
	level: number;
	/** 分析模型："follow-current" 或 "provider/id"。 */
	model: string;
	/** 思考强度（reasoningEffort），按分析模型支持列表过滤。 */
	effort: string;
}

const DEFAULT_CONFIG: TLAPConfig = {
	enabled: true,
	level: 2,
	model: "follow-current",
	effort: "minimal",
};

function loadConfig(): TLAPConfig {
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
			return { ...DEFAULT_CONFIG, ...raw };
		}
	} catch (err) {
		console.error("[talk-like-a-pro] failed to load config:", err);
	}
	return { ...DEFAULT_CONFIG };
}

let config: TLAPConfig = loadConfig();

function saveConfig() {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
	} catch (err) {
		console.error("[talk-like-a-pro] failed to save config:", err);
	}
}

// ============================================================================
// 翻译层级
// ============================================================================

const LEVEL_NAMES: Record<number, string> = {
	1: "1 · 入门 (Beginner)",
	2: "2 · 标准 (Standard)",
};

const LEVEL_VALUES = [LEVEL_NAMES[1], LEVEL_NAMES[2]];

function parseLevelLabel(label: string): number | null {
	if (label.startsWith("1")) return 1;
	if (label.startsWith("2")) return 2;
	return null;
}

function parseLevelArg(raw: string): number | null {
	const v = raw.trim().toLowerCase();
	if (v === "1" || v === "beginner" || v === "入门") return 1;
	if (v === "2" || v === "standard" || v === "标准") return 2;
	return null;
}

// ============================================================================
// 启发式预筛选
// ============================================================================

// 模糊动词：中文 + 英文常见模糊表达
const FUZZY_KEYWORDS =
	/\b(弄|搞|整|处理|修一下|加个|弄成|写个|做一下|改进|调整|优化|搞个|帮忙|帮我|想要|需要|想[要请]|implement|fix|handle|tweak|polish|clean)\b/i;

// 具体目标信号：文件名/扩展名/常见技术名词/路径
const HAS_SPECIFIC_TARGET =
	/\b\w+\.(ts|js|py|go|rs|java|tsx|jsx|md|json|yaml|yml|toml|sh)\b|\b(src|test|lib|dist|build)\/|\b(function|class|method|api|endpoint|module|component|interface|type|struct|enum)\b|\b\w+\(\)/i;

/**
 * 启发式判断是否值得走 LLM 分析。
 * 返回 true = 可能是模糊需求，进 LLM 二次判定。
 */
function shouldConsiderFuzzy(text: string): boolean {
	const stripped = text.replace(/^\/[!!]?\s*/, "").trim();
	if (stripped.length < 3) return false;
	// 长 + 有具体目标 → 大概率不需要翻译
	if (stripped.length > 80 && HAS_SPECIFIC_TARGET.test(stripped)) return false;
	// 含模糊关键词 → 几乎一定是模糊需求
	if (FUZZY_KEYWORDS.test(stripped)) return true;
	// 极短 → 可能是模糊
	if (stripped.length < 15) return true;
	return false;
}

// ============================================================================
// 上下文探索
// ============================================================================

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function tryExec(pi: ExtensionAPI, cmd: string, args: string[]): Promise<ExecResult | null> {
	try {
		const result = await pi.exec(cmd, args);
		return {
			code: result.code,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	} catch {
		return null;
	}
}

async function exploreContext(pi: ExtensionAPI, ctx: any): Promise<string> {
	const parts: string[] = [];

	// cwd
	const pwd = await tryExec(pi, "pwd", []);
	if (pwd?.code === 0) parts.push(`cwd: ${pwd.stdout.trim()}`);

	// git status --short
	const gitStatus = await tryExec(pi, "git", ["status", "--short"]);
	if (gitStatus?.code === 0 && gitStatus.stdout.trim()) {
		parts.push(`git status --short:\n${gitStatus.stdout.trim().slice(0, 800)}`);
	}

	// AGENTS.md / CLAUDE.md（前 1200 字符）
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const exists = await tryExec(pi, "test", ["-f", name]);
		if (exists?.code === 0) {
			const head = await tryExec(pi, "head", ["-c", "1200", name]);
			if (head?.code === 0 && head.stdout.trim()) {
				parts.push(`${name} (first 1200 chars):\n${head.stdout}`);
			}
		}
	}

	// session 最近几条（user/assistant 摘要）
	const branch = ctx.sessionManager.getBranch();
	const recent = branch.slice(-6);
	const recentLines: string[] = [];
	for (const e of recent) {
		const entry = e as any;
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((c: any) => c?.type === "text")
							.map((c: any) => c.text)
							.join("")
					: "";
		if (!text.trim()) continue;
		recentLines.push(`${role}: ${text.slice(0, 250)}`);
	}
	if (recentLines.length) parts.push(`recent conversation:\n${recentLines.join("\n")}`);

	return parts.join("\n\n");
}

// ============================================================================
// LLM 意图分析
// ============================================================================

interface AnalysisQuestion {
	id: string;
	prompt: string;
	options: Array<{ label: string; description?: string }>;
	allowFreeInput?: boolean;
}

interface AnalysisResult {
	isAmbiguous: boolean;
	confidence: number;
	reason: string;
	refinedPrompt: string;
	questions?: AnalysisQuestion[];
}

// 各层级在 prompt 里的差异块（影响追问策略 + refinedPrompt 模板）
// 两档设计：
//   L1 入门 = 保姆级任务书（怎么做 / 做到什么程度 / 怎么验收全部写清）
//   L2 标准 = 高效补充式 prompt（只补关键缺失信息，默认档）
const LEVEL_PROMPT_BLOCKS: Record<number, string> = {
	1: [
		"## Level: beginner (入门) — produce a complete task spec",
		"- Ask up to 3 clarifying questions when ambiguous; plain spoken Chinese, always with concrete options.",
		"- reason (Chinese): plain-language, < 40 chars.",
		"- refinedPrompt must be a COMPLETE task spec: one-line intent + implied needs + 4+ concrete requirements (including boundaries / non-goals) + context (working dir, related files, existing conventions, user background assumption) + 3+ verifiable acceptance criteria.",
		"",
		"## refinedPrompt template (Chinese, detailed task spec)",
		"",
		"[Refined Task] <一句话意图，用最简单的说法>",
		"",
		"## 用户意图",
		"<意图分析，把隐含需求也写出来>",
		"",
		"## 具体要求",
		"- 要求 1（写清做什么、做到什么程度）",
		"- 要求 2",
		"- 要求 3",
		"- 要求 4（边界 / 不做的事也写明）",
		"",
		"## 上下文",
		"- 工作目录：...",
		"- 相关文件：...（尽量引用实际文件名）",
		"- 现有约定：...（AGENTS.md / 代码风格等）",
		"- 用户背景假设：按非技术用户能理解的程度写验收描述",
		"",
		"## 验收标准",
		"- 标准 1（可验证、具体）",
		"- 标准 2",
		"- 标准 3",
		"",
	].join("\n"),
	2: [
		"## Level: standard (标准) — fill only the missing key info",
		"- Ask 1-3 clarifying questions when ambiguous; options with brief descriptions.",
		"- reason (Chinese): < 30 chars.",
		"- refinedPrompt fills only what the raw request lacks: one-line intent + 2-3 concrete requirements + context (working dir, files, conventions) + 2 verifiable acceptance criteria. No padding.",
		"",
		"## refinedPrompt template (Chinese, structured)",
		"",
		"[Refined Task] <一句话意图>",
		"",
		"## 用户意图",
		"<意图分析>",
		"",
		"## 具体要求",
		"- 要求 1",
		"- 要求 2",
		"",
		"## 上下文",
		"- 工作目录：...",
		"- 相关文件：...",
		"- 现有约定：...",
		"",
		"## 验收标准",
		"- 标准 1",
		"- 标准 2",
		"",
	].join("\n"),
};

function buildAnalyzerPrompt(
	context: string,
	userInput: string,
	previousAnswers?: Record<string, string>,
	level: number = 2,
): string {
	const answersBlock =
		previousAnswers && Object.keys(previousAnswers).length > 0
			? `\n<previous_answers>\n${Object.entries(previousAnswers)
					.map(([k, v]) => `Q:${k}\nA:${v}`)
					.join("\n\n")}\n</previous_answers>\n`
			: "";

	const levelBlock = LEVEL_PROMPT_BLOCKS[level] ?? LEVEL_PROMPT_BLOCKS[2];

	return [
		"You are a 'prompt-refining' assistant inside a coding agent (pi).",
		"Your job: read a possibly vague user request and turn it into a precise prompt for the coding agent to execute.",
		"",
		"## Decision rules",
		"- isAmbiguous=true when: intent unclear, target unclear, critical constraints missing, or 2+ very different interpretations.",
		"- isAmbiguous=false when: specific file/feature/function mentioned, concrete action verb, or only one sensible interpretation.",
		"",
		"## Context",
		"<context>",
		context || "(no extra context)",
		"</context>",
		"",
		"## User's raw request",
		"<user_input>",
		userInput,
		"</user_input>",
		answersBlock,
		"## Output format",
		"Return ONLY a JSON object. No markdown fence, no prose before/after.",
		"",
		"{",
		'  "isAmbiguous": boolean,',
		'  "confidence": 0-1,                  // 0=very clear, 1=very ambiguous',
		'  "reason": string,                    // Chinese, shown to user as status notification',
		'  "refinedPrompt": string,             // Complete prompt for the coding agent (use template below)',
		'  "questions": [                       // Only when isAmbiguous=true; 1-3 questions',
		"    {",
		'      "id": string,',
		'      "prompt": string,                // Chinese question',
		'      "options": [{ "label": string, "description": string }],  // 2-5 options; label self-contained (UI is simple list)',
		'      "allowFreeInput": boolean        // default true',
		"    }",
		"  ]",
		"}",
		"",
		levelBlock,
		"Now analyze the request and output JSON.",
	].join("\n");
}

function parseAnalysis(text: string): AnalysisResult {
	let s = text.trim();
	// 剥离 markdown fence
	s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
	// 找第一个 { 和最后一个 }
	const start = s.indexOf("{");
	const end = s.lastIndexOf("}");
	if (start < 0 || end < 0) {
		throw new Error(`no JSON object found in LLM output: ${text.slice(0, 200)}`);
	}
	s = s.slice(start, end + 1);
	let parsed: any;
	try {
		parsed = JSON.parse(s);
	} catch (e: any) {
		throw new Error(`JSON parse failed: ${e.message}; raw: ${text.slice(0, 200)}`);
	}
	if (typeof parsed.isAmbiguous !== "boolean") {
		throw new Error(`missing isAmbiguous field; raw: ${text.slice(0, 200)}`);
	}
	if (typeof parsed.refinedPrompt !== "string" || !parsed.refinedPrompt.trim()) {
		throw new Error(`missing or empty refinedPrompt; raw: ${text.slice(0, 200)}`);
	}
	return {
		isAmbiguous: parsed.isAmbiguous,
		confidence:
			typeof parsed.confidence === "number"
				? Math.max(0, Math.min(1, parsed.confidence))
				: parsed.isAmbiguous
					? 0.8
					: 0.2,
		reason: typeof parsed.reason === "string" ? parsed.reason : "",
		refinedPrompt: parsed.refinedPrompt.trim(),
		questions: Array.isArray(parsed.questions) ? parsed.questions : undefined,
	};
}

// ============================================================================
// 模型与思考强度解析
// ============================================================================

const ALL_EFFORTS = ["off", "minimal", "low", "medium", "high", "max"];

// 兜底 effort 优先级：reasoning 模型在 off/低档下可能不产出内容，
// 优先选能稳定出文的档位（high/max），最后才轮到 off。
const EFFORT_FALLBACK_PRIORITY = ["high", "max", "minimal", "low", "medium", "off"];

function pickFallbackEffort(levels: string[]): string {
	for (const p of EFFORT_FALLBACK_PRIORITY) {
		if (levels.includes(p)) return p;
	}
	return levels[0] ?? "off";
}

/**
 * 解析分析用的模型：配置了具体模型则依次从 scopedModels、modelRegistry
 * 查找，找不到或配置为 follow-current 时回退到会话当前模型。
 */
function resolveAnalyzerModel(ctx: any): any {
	const fallback = ctx.model ?? null;
	if (!config.model || config.model === "follow-current") return fallback;

	const slash = config.model.indexOf("/");
	const provider = slash > 0 ? config.model.slice(0, slash) : undefined;
	const id = slash > 0 ? config.model.slice(slash + 1) : config.model;

	// 1) 会话 scoped 模型
	const scoped: Array<{ model: any }> = ctx.scopedModels ?? [];
	const found = scoped.find(
		(s) => `${s.model.provider}/${s.model.id}` === config.model || s.model.id === id,
	);
	if (found?.model) return found.model;

	// 2) 模型注册表（scopedModels 为空时也能解析）
	const reg = ctx.modelRegistry;
	if (reg) {
		try {
			if (provider && typeof reg.find === "function") {
				const m = reg.find(provider, id);
				if (m) return m;
			}
			const avail: any[] = reg.getAvailable?.() ?? [];
			const m = avail.find(
				(x: any) => `${x.provider}/${x.id}` === config.model || x.id === id,
			);
			if (m) return m;
		} catch {
			// fall through to fallback
		}
	}

	return fallback;
}

/** 分析模型支持的思考强度列表（按模型 thinkingLevelMap 过滤）。 */
function supportedEfforts(ctx: any): string[] {
	const model = resolveAnalyzerModel(ctx) ?? ctx.model;
	if (!model) return [...ALL_EFFORTS];
	try {
		const levels = getSupportedThinkingLevels(model);
		if (Array.isArray(levels) && levels.length > 0) return levels as string[];
	} catch {
		// fall through
	}
	return [...ALL_EFFORTS];
}

async function callAnalyzer(
	pi: ExtensionAPI,
	ctx: any,
	prompt: string,
): Promise<AnalysisResult> {
	const model = resolveAnalyzerModel(ctx);
	if (!model) throw new Error("no current model");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) throw new Error("model auth not ok or no api key");

	// effort：配置值不在模型支持列表时，按优先级兜底（避免落到 off 空输出陷阱）
	const levels = supportedEfforts(ctx);
	let effort = config.effort;
	if (!levels.includes(effort)) effort = pickFallbackEffort(levels);

	const options = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		reasoningEffort: effort,
		cacheRetention: "none",
		sessionId: uuidv7(),
	};

	// 单次 complete 调用，返回文本内容
	const runOnce = async (eff: string, msg: string): Promise<string> => {
		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: msg }],
						timestamp: Date.now(),
					},
				],
			},
			{ ...options, reasoningEffort: eff },
		);
		return response.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("");
	};

	let text = await runOnce(effort, prompt);

	// 空输出兜底：reasoning 模型在 off/低 effort 下可能不产出内容，高一档重试一次
	if (!text.trim()) {
		const higher = pickFallbackEffort(levels.filter((l) => l !== "off" && l !== effort));
		if (higher) {
			console.warn(
				`Talk like a Pro: empty output at effort=${effort}, retrying at ${higher}`,
			);
			text = await runOnce(higher, prompt);
		}
	}

	try {
		return parseAnalysis(text);
	} catch (parseErr: any) {
		// parse 失败时重试一次，prompt 加强
		console.error("Talk like a Pro: parse failed, retrying:", parseErr?.message || parseErr);
		const retryText = await runOnce(
			effort,
			`${prompt}\n\nIMPORTANT: Reply with ONLY a valid JSON object. No markdown fence, no prose, no explanation.`,
		);
		return parseAnalysis(retryText); // 再失败就 throw
	}
}

/**
 * 安全包装：捕获 callAnalyzer 的错误并通过 ctx.ui.notify 显示，
 * 返回 null 让主入口 pass through。
 */
async function safeAnalyze(
	pi: ExtensionAPI,
	ctx: any,
	prompt: string,
): Promise<AnalysisResult | null> {
	try {
		return await callAnalyzer(pi, ctx, prompt);
	} catch (err: any) {
		const msg = (err?.message || String(err) || "").slice(0, 180);
		console.error("Talk like a Pro: analyze failed:", err);
		if (ctx.hasUI) ctx.ui.notify(`Talk like a Pro 失败: ${msg}`, "error");
		return null;
	}
}

// ============================================================================
// 多轮问答
// ============================================================================

async function askQuestions(
	pi: ExtensionAPI,
	ctx: any,
	questions: AnalysisQuestion[],
): Promise<Record<string, string> | null> {
	const answers: Record<string, string> = {};

	for (const q of questions) {
		if (!ctx.hasUI) return null;

		// 有选项 → select；最后一项 "直接输入" 兜底
		const hasOptions = Array.isArray(q.options) && q.options.length > 0;
		const allowFree = q.allowFreeInput !== false;

		if (hasOptions) {
			const labels = q.options.map((o) => o.label);
			const selectOptions = allowFree ? [...labels, "（直接输入）"] : labels;

			const choice = await ctx.ui.select(q.prompt, selectOptions);
			if (choice === undefined) return null; // user cancelled

			if (choice === "（直接输入）") {
				const text = await ctx.ui.input(q.prompt, "");
				if (text === undefined) return null;
				answers[q.id] = text.trim();
			} else {
				const opt = q.options.find((o) => o.label === choice);
				answers[q.id] = opt?.description ? `${choice}（${opt.description}）` : choice;
			}
		} else {
			// 无选项 → 直接输入
			const text = await ctx.ui.input(q.prompt, "");
			if (text === undefined) return null;
			answers[q.id] = text.trim();
		}
	}

	return answers;
}

// ============================================================================
// 页脚状态指示
// ============================================================================

function updateStatus(ctx: any) {
	if (!config.enabled) {
		ctx.ui?.setStatus?.("talk-like-a-pro", undefined);
		return;
	}
	const label = LEVEL_NAMES[config.level]?.split(" ")[0] ?? "L" + config.level;
	const styled = ctx.ui?.theme?.fg
		? ctx.ui.theme.fg("accent", `● TLAP ${label}`)
		: `● TLAP ${label}`;
	ctx.ui?.setStatus?.("talk-like-a-pro", styled);
}

// ============================================================================
// 设置 UI（TUI）
// ============================================================================

function modelDisplayName(modelId: string): string {
	if (!modelId || modelId === "follow-current") return "跟随当前模型";
	return modelId;
}

/** 设置 UI 里的模型选择列表：scopedModels 非空用它，否则回退到已配置 auth 的可用模型。 */
function getModelChoices(ctx: any): Array<{ label: string; value: string; description: string }> {
	const seen = new Set<string>();
	const push = (m: any) => {
		const key = `${m.provider}/${m.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		choices.push({
			label: key,
			value: key,
			description: m.name ?? "",
		});
	};
	const choices: Array<{ label: string; value: string; description: string }> = [
		{
			label: "跟随当前模型",
			value: "follow-current",
			description: "用会话当前模型做意图分析",
		},
	];

	const scoped: Array<{ model: any }> = ctx.scopedModels ?? [];
	if (scoped.length > 0) {
		for (const s of scoped) push(s.model);
		return choices;
	}

	// scopedModels 为空（未配置模型 scoping）：用注册表里已配置 auth 的模型
	const reg = ctx.modelRegistry;
	const all: any[] = reg?.getAvailable?.() ?? [];
	for (const m of all) {
		try {
			if (reg?.hasConfiguredAuth?.(m)) push(m);
		} catch {
			push(m);
		}
	}
	return choices;
}

/** 选择分析模型（SelectList overlay），选完重开主界面。 */
function openModelPicker(ctx: any) {
	const items: SelectItem[] = getModelChoices(ctx);

	ctx.ui.custom(
		(tui: any, theme: any, _kb: any, done: (v?: unknown) => void) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold("Talk like a Pro · 选择分析模型")), 1, 0),
			);
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						`↑↓ 选择 · Enter 确认 · Esc 取消（共 ${items.length} 个模型）`,
					),
					1,
					0,
				),
			);
			const selectList = new SelectList(
				items,
				Math.min(items.length, 10),
				{
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				},
			);
			selectList.onSelect = (selected: SelectItem) => {
				config.model = String(selected.value);
				// effort 跟随模型：新模型的可用档位不含当前值时自动修正
				if (config.model !== "follow-current") {
					const levels = supportedEfforts(ctx);
					if (!levels.includes(config.effort)) {
						config.effort = pickFallbackEffort(levels);
					}
				}
				saveConfig();
				done(undefined);
				// 选完重开主界面，刷新 currentValue 与 effort 列表
				setTimeout(() => openSettingsUI(ctx), 0);
			};
			selectList.onCancel = () => {
				done(undefined);
				setTimeout(() => openSettingsUI(ctx), 0);
			};
			container.addChild(selectList);
			container.addChild(
				new Text(theme.fg("dim", "↑↓ 选择 · Enter 确认 · Esc 取消"), 1, 0),
			);
			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: { width: 72, maxHeight: 16, anchor: "center" } },
	);
}

/** 主设置界面（SettingsList）。 */
function openSettingsUI(ctx: any) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/talk-like-a-pro 设置界面需要 TUI 模式", "error");
		return;
	}

	const efforts = supportedEfforts(ctx);
	const effortValues = efforts.length > 0 ? efforts : [...ALL_EFFORTS];
	let currentEffort = config.effort;
	if (!effortValues.includes(currentEffort)) currentEffort = effortValues[0];

	ctx.ui.custom((tui: any, theme: any, _kb: any, done: (v?: unknown) => void) => {
		const items: SettingItem[] = [
			{
				id: "enabled",
				label: "启用翻译 Enable",
				currentValue: config.enabled ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "level",
				label: "翻译层级 Level",
				currentValue: LEVEL_NAMES[config.level] ?? LEVEL_NAMES[2],
				values: LEVEL_VALUES,
			},
			{
				id: "model",
				label: "分析模型 Analyzer model",
				currentValue: modelDisplayName(config.model),
				values: ["选择模型…"],
			},
			{
				id: "effort",
				label: "思考强度 Effort",
				currentValue: currentEffort,
				values: effortValues,
			},
		];

		const container = new Container();
		container.addChild(
			new Text(theme.fg("accent", theme.bold("Talk like a Pro · Settings")), 1, 1),
		);
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					"回车切换值 · 输入 / 搜索 · Esc 保存并关闭 · 模型项回车进入选择列表",
				),
				1,
				0,
			),
		);

		const settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "enabled":
						config.enabled = newValue === "on";
						saveConfig();
						updateStatus(ctx);
						break;
					case "level": {
						const n = parseLevelLabel(newValue);
						if (n !== null) {
							config.level = n;
							saveConfig();
						}
						break;
					}
					case "model":
						// 子菜单：关闭当前界面 → 打开模型选择
						done(undefined);
						setTimeout(() => openModelPicker(ctx), 0);
						break;
					case "effort":
						config.effort = newValue;
						saveConfig();
						break;
				}
			},
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(settingsList);

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

// ============================================================================
// 主入口
// ============================================================================

export default function translatorExtension(pi: ExtensionAPI) {
	// 跨 session 恢复页脚状态
	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	// 设置命令：无参数 → TUI；on|off|status|level N|model X|effort Y
	pi.registerCommand("talk-like-a-pro", {
		description:
			"配置 Talk like a Pro。无参数打开设置界面；用法: on | off | status | level 1|2 | model <provider/id> | effort <off|minimal|low|medium|high|max>",
		getArgumentCompletions: (prefix: string) => {
			const all = [
				"on",
				"off",
				"status",
				"level",
				"model",
				"effort",
				"1",
				"2",
				"3",
				"beginner",
				"standard",
				"follow-current",
			];
			const filtered = all.filter((o) => o.startsWith(prefix.toLowerCase()));
			return filtered.length > 0
				? filtered.map((o) => ({ value: o, label: o }))
				: null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (!trimmed) {
				openSettingsUI(ctx);
				return;
			}

			const parts = trimmed.split(/\s+/);
			const first = parts[0].toLowerCase();

			if (first === "on") {
				config.enabled = true;
				saveConfig();
				updateStatus(ctx);
				ctx.ui.notify(`Talk like a Pro: 已启用（层级 ${LEVEL_NAMES[config.level]?.split(" ")[0] ?? config.level}）`, "info");
				return;
			}
			if (first === "off") {
				config.enabled = false;
				saveConfig();
				updateStatus(ctx);
				ctx.ui.notify("Talk like a Pro: 已停用", "info");
				return;
			}
			if (first === "status") {
				const level = LEVEL_NAMES[config.level] ?? config.level;
				const model = modelDisplayName(config.model);
				ctx.ui.notify(
					`Talk like a Pro: ${config.enabled ? "启用" : "停用"} · 层级 ${level} · 模型 ${model} · effort ${config.effort}`,
					"info",
				);
				return;
			}
			if (first === "level") {
				if (parts.length < 2) {
					ctx.ui.notify(
						`Talk like a Pro: 当前层级 ${LEVEL_NAMES[config.level] ?? config.level}。用法: level 1|2`,
						"info",
					);
					return;
				}
				const level = parseLevelArg(parts[1]);
				if (level === null) {
					ctx.ui.notify("Talk like a Pro: 无效层级。用法: level 1|2 (或 beginner|standard)", "warning");
					return;
				}
				config.level = level;
				saveConfig();
				updateStatus(ctx);
				ctx.ui.notify(`Talk like a Pro: 层级已设为 ${LEVEL_NAMES[level]}`, "info");
				return;
			}
			if (first === "model") {
				if (parts.length < 2) {
					ctx.ui.notify(
						`Talk like a Pro: 当前分析模型 ${modelDisplayName(config.model)}。用法: model follow-current | <provider/id>`,
						"info",
					);
					return;
				}
				config.model = parts[1];
				saveConfig();
				ctx.ui.notify(`Talk like a Pro: 分析模型已设为 ${modelDisplayName(config.model)}`, "info");
				return;
			}
			if (first === "effort") {
				if (parts.length < 2) {
					const ok = supportedEfforts(ctx).join(" | ");
					ctx.ui.notify(
						`Talk like a Pro: 当前 effort ${config.effort}。当前模型支持: ${ok}`,
						"info",
					);
					return;
				}
				const efforts = supportedEfforts(ctx);
				if (!efforts.includes(parts[1])) {
					ctx.ui.notify(
						`Talk like a Pro: 无效 effort（当前模型支持: ${efforts.join(" | ")}）`,
						"warning",
					);
					return;
				}
				config.effort = parts[1];
				saveConfig();
				ctx.ui.notify(`Talk like a Pro: effort 已设为 ${config.effort}`, "info");
				return;
			}

			ctx.ui.notify(
				`Talk like a Pro: 未知参数 "${first}"。用法: 无参数(设置界面) | on | off | status | level 1|2 | model <id> | effort <level>`,
				"warning",
			);
		},
	});

	pi.on("input", async (event, ctx) => {
		// 跳过扩展自身注入的消息，避免循环
		if (event.source !== "interactive") return { action: "continue" };

		let text = event.text.trim();
		if (!text) return { action: "continue" };

		// 强制控制前缀
		let forceMode: "on" | "off" | null = null;
		if (text.startsWith("/!!")) {
			forceMode = "on";
			text = text.slice(3).trim();
		} else if (text.startsWith("/!")) {
			forceMode = "off";
			text = text.slice(2).trim();
		}
		if (!text) return { action: "continue" };

		// 总开关（/!! 强制翻译不受开关限制）
		if (forceMode !== "on" && !config.enabled) {
			return { action: "continue" };
		}

		// 启发式预筛选
		if (forceMode !== "on" && !shouldConsiderFuzzy(text)) {
			return { action: "continue" };
		}

		// 强制不翻译：剥离前缀后 pass through
		if (forceMode === "off") {
			return { action: "transform", text };
		}

		// 探索上下文
		if (ctx.hasUI) ctx.ui.notify("Talk like a Pro: 探索上下文...", "info");
		const context = await exploreContext(pi, ctx);

		// 第一次分析
		if (ctx.hasUI) ctx.ui.notify("Talk like a Pro: 分析意图...", "info");
		let prompt = buildAnalyzerPrompt(context, text, undefined, config.level);
		let analysis = await safeAnalyze(pi, ctx, prompt);

		if (!analysis) {
			// safeAnalyze 已经 notify 过错误；这里 pass through，不打扰
			return { action: "continue" };
		}

		// 不清楚 → 多轮问答 → 二次合成
		if (analysis.isAmbiguous && analysis.questions && analysis.questions.length > 0) {
			if (!ctx.hasUI) {
				// 无 UI 时无法问答，直接 pass through
				return { action: "continue" };
			}

			ctx.ui.notify("Talk like a Pro: 需要澄清几个问题", "info");
			const answers = await askQuestions(pi, ctx, analysis.questions);
			if (!answers) {
				ctx.ui.notify("Talk like a Pro: 已取消，保持原输入", "warning");
				return { action: "continue" };
			}

			// 二次合成
			ctx.ui.notify("Talk like a Pro: 生成最终 prompt...", "info");
			prompt = buildAnalyzerPrompt(context, text, answers, config.level);
			const finalAnalysis = await safeAnalyze(pi, ctx, prompt);
			if (!finalAnalysis) {
				// safeAnalyze 已经 notify 过错误
				return { action: "continue" };
			}
			analysis = finalAnalysis;
		}

		// 通知 + transform
		const reasonText = analysis.reason ? `（${analysis.reason}）` : "";
		ctx.ui.notify(`Talk like a Pro 已翻译${reasonText}`, "info");
		return { action: "transform", text: analysis.refinedPrompt };
	});
}
