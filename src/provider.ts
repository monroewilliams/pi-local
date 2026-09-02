import type {
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Model,
	Provider,
	RefreshModelsContext,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { ProviderStreamOptions } from "@earendil-works/pi-ai/compat";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import { encodeProviderId } from "./config.ts";
import type { ApiType, DiscoveredModel, QueryResult } from "./model-picker.ts";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

/** Thinking levels pi can select, in selector order. */
const PI_THINKING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/**
 * Build a thinkingLevelMap for a server that advertises a strict
 * reasoning_effort vocabulary (oMLX discovery, /v1/models/status).
 *
 * The menu is ordered by pi's ladder, not by the order the server happened to
 * enumerate: a template that spells its branches `high … low` would otherwise
 * put the sharpest setting first in the selector. Levels pi has no name for
 * are hidden (null) rather than guessed at, and "none" — how oMLX spells off —
 * becomes `off`. Returns undefined when fewer than two pi levels survive,
 * because one entry is not a menu: gpt-oss advertises exactly ["medium"], and
 * pinning the selector to a single choice the server then ignores is worse
 * than offering the plain on/off toggle.
 */
export function buildThinkingLevelMap(
	options: readonly string[],
): ThinkingLevelMap | undefined {
	const map: ThinkingLevelMap = {};
	let matched = 0;
	for (const level of PI_THINKING_LEVELS) {
		if (options.includes(level)) {
			map[level] = level;
			matched++;
		} else {
			map[level] = null;
		}
	}
	if (matched < 2) return undefined;
	map.off = "none";
	return map;
}

/**
 * The full pi ladder, passed through verbatim as top-level `reasoning_effort`,
 * with `off` mapped to "none".
 *
 * Used by two fallbacks. pi offers `xhigh` and `max` only when a model maps
 * them explicitly, so an unmapped model caps out at `high` — a needless ceiling
 * on a server that takes the whole vocabulary. Handing the user the complete
 * list is the useful default: a level the model ignores costs nothing, while a
 * level withheld is a setting nobody can try.
 *
 * llama.cpp accepts all of these, including "max": it forwards the string to
 * the chat template and ignores it when the template doesn't read
 * `reasoning_effort`. The same holds for oMLX on a model that advertised no
 * vocabulary — no vocabulary means no whitelist, so any level passes through.
 *
 * "none" is how thinking goes off: llama.cpp special-cases it into
 * `enable_thinking = false` and drops the kwarg rather than forwarding it, and
 * oMLX from the discovery PR onwards does the same.
 */
export function buildPassthroughThinkingLevelMap(): ThinkingLevelMap {
	return {
		off: "none",
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	};
}

/**
 * Human-readable display name for a base URL provider.
 * Strips protocol and trailing slash: "http://127.0.0.1:1234" → "127.0.0.1:1234"
 */
export function providerDisplayName(baseUrl: string): string {
	return baseUrl.replace(/^https?:\/\//, "").replace(/\/?$/, "");
}

export function toModel(
	m: DiscoveredModel,
	baseUrl: string,
	apiType?: ApiType,
): Model<"openai-completions"> {
	let compat: Record<string, unknown> | undefined;
	let thinkingLevelMap: ThinkingLevelMap | undefined;
	if (apiType === "omlx") {
		// oMLX reports which knob the chat template reads, and pi's thinkingFormat
		// selects exactly one wire shape (openai-completions.js: the
		// qwen-chat-template branch never emits reasoning_effort), so the two are
		// chosen between rather than combined.
		//
		// The sets turn out to be disjoint anyway: oMLX only advertises an effort
		// vocabulary when the template consumes reasoning_effort, which is exactly
		// the condition under which effort is not inert. Everything else has to be
		// driven by enable_thinking, and qwen-chat-template sends
		// `enable_thinking: !!reasoningEffort` — so off becomes false and any
		// selected level true, with no "none" ever leaving this client.
		// The ladder is always offered: taking levels away is the costlier mistake,
		// since a level the template ignores costs nothing while a withheld one is a
		// setting nobody can try. What the server's answer does decide is the wire
		// format, because pi's thinkingFormat selects exactly one shape
		// (openai-completions.js: the chat-template branch emits reasoning_effort
		// from $var and the qwen-chat-template branch emits none).
		const menu = m.reasoningEffortOptions
			? buildThinkingLevelMap(m.reasoningEffortOptions)
			: undefined;
		thinkingLevelMap = menu ?? buildPassthroughThinkingLevelMap();
		if (menu) {
			// The template names the levels, so it reads reasoning_effort.
			compat = { supportsReasoningEffort: true };
		} else {
			// No named vocabulary. If the template has an enable_thinking switch,
			// drive it directly: every level above off arrives as
			// `enable_thinking: true`, so the selector works on a model that takes
			// no effort values at all.
			//
			// chat-template rather than qwen-chat-template: both write
			// chat_template_kwargs and $var:thinking.enabled resolves to the same
			// !!reasoningEffort, but qwen-chat-template hardcodes
			// `preserve_thinking: true` and so overrides a template that clears
			// history by default. Passing preserve_thinking only when oMLX actually
			// discovered it leaves the server's own default in charge otherwise.
			// No omitWhenOff on the toggle — a template that thinks unless told not
			// to must receive an explicit false.
			if (m.thinkingDefault !== undefined) {
				compat = {
					thinkingFormat: "chat-template" as const,
					chatTemplateKwargs: {
						enable_thinking: { $var: "thinking.enabled" },
						...(m.preserveThinkingDefault === undefined
							? {}
							: { preserve_thinking: m.preserveThinkingDefault }),
					},
				};
			} else {
				// Neither a named vocabulary nor an enable_thinking switch — gpt-oss
				// (one level is no menu) and GLM before the discovery PR. Effort is
				// the remaining channel, and a template with no whitelist takes any
				// level the user picks.
				compat = { supportsReasoningEffort: true };
			}
		}
	} else if (
		apiType === undefined ||
		apiType === "openai" ||
		apiType === "llamaswap" ||
		apiType === "lmstudio"
	) {
		// "I don't know which engine this is" (llama.cpp lands here: its
		// /v1/models advertises nothing about reasoning). No per-format
		// thinkingFormat, just pi's OpenAI-generic branch: send the selected
		// level as top-level `reasoning_effort`, "none" to disable thinking.
		//
		// llama-swap is in here on purpose and not by omission: it is a proxy
		// that rewrites only `model` in the request body and forwards
		// `reasoning_effort` and `chat_template_kwargs` untouched, so thinking
		// behaves exactly like whatever engine sits behind it.
		//
		// LM Studio comes along for the same ride. Its `capabilities.reasoning`
		// does name a vocabulary, but across a whole HF cache the only model that
		// populates it answers `["off", "on"]` — the ladder collapsed to a switch,
		// which the full map already covers. Trusting it would cap every LM Studio
		// model at whatever one GGUF happened to report.
		thinkingLevelMap = buildPassthroughThinkingLevelMap();
		compat = { supportsReasoningEffort: true };
	}
	// pi's reasoning_effort branches (generic and format-specific) only fire
	// when model.reasoning is set, and the level selector only appears when
	// reasoning is true, so a built map implies reasoning support.
	const reasoning = thinkingLevelMap ? true : (m.reasoning ?? false);
	return {
		id: m.id,
		name: m.displayName,
		api: "openai-completions",
		provider: encodeProviderId(baseUrl),
		baseUrl: `${baseUrl}/v1`,
		reasoning,
		compat,
		thinkingLevelMap,
		input:
			m.vision || m.modelType?.includes("vlm") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
	};
}

/**
 * Seam for request-time thinking decisions. Currently a pass-through.
 *
 * The thinking format is decided once, at discovery, because it follows from a
 * property of the model rather than of the selected level. oMLX's merge
 * (api/utils.py) turns `"none"` into `enable_thinking: False` while every
 * other level forwards `reasoning_effort` alone, so effort switches thinking
 * *off* on any template and switches it *on* only where the template reads
 * `reasoning_effort` — gpt-oss among them. On Qwen, Gemma, LongCat, Ornith and
 * ThinkingCap the level reaches the template through `enable_thinking`, so the
 * same format has to carry every level including off.
 */
export function adaptModelForRequest(
	model: Model<"openai-completions">,
	_level?: string,
): Model<"openai-completions"> {
	return model;
}

/**
 * Create a full native Provider for a local inference server connection.
 *
 * This enables:
 * - /login <baseUrl> to configure API key via pi's native auth flow
 * - Models appearing in /model selector via refreshModels()
 * - Live catalog refresh when the model picker opens
 *
 * @param baseUrl         The server base URL (encoded into the provider id)
 * @param storedApiKey    Raw API key reference (!command, $ENV_VAR, or direct)
 * @param resolveApiKey   Function to resolve the raw reference to an actual key
 * @param queryModels     Function to live-query available models from the server
 * @param initialModels   Optional pre-populated models (from saved metadata)
 */
export function createLocalProvider(
	baseUrl: string,
	storedApiKey: string,
	resolveApiKey: (raw: string) => string,
	queryModels: (url: string, key: string) => Promise<QueryResult>,
	initialModels?: Model<"openai-completions">[],
): Provider<"openai-completions"> {
	let models: Model<"openai-completions">[] = initialModels ?? [];
	let detectedApiType: ApiType | undefined;

	return {
		id: encodeProviderId(baseUrl),
		name: providerDisplayName(baseUrl),

		auth: {
			apiKey: {
				name: "Local server",

				// Called by /login when user selects this provider.
				login: async (interaction): Promise<ApiKeyCredential> => {
					const apiKey = (
						await interaction.prompt({
							type: "secret",
							message: `API key for ${baseUrl}`,
							placeholder: "",
						})
					).trim();
					return { type: "api_key", key: apiKey || undefined };
				},

				resolve: async ({
					ctx,
					credential,
				}: {
					ctx: AuthContext;
					credential?: ApiKeyCredential;
				}): Promise<AuthResult | undefined> => {
					let key = credential?.key;
					if (!key?.trim()) {
						key = resolveApiKey(storedApiKey);
					}
					if (!key?.trim()) {
						const envKey = (await ctx.env("API_KEY"))?.trim();
						if (envKey) key = envKey;
					}

					if (!key) {
						// Some local servers don't need an API key; pass a dummy
						return {
							auth: { apiKey: "unused", baseUrl: `${baseUrl}/v1` },
							source: "pi-local config (no key required)",
						};
					}

					return {
						auth: { apiKey: key, baseUrl: `${baseUrl}/v1` },
						source: credential ? "stored credential" : "pi-local config",
					};
				},
			},
		},

		getModels: (): readonly Model<"openai-completions">[] => models,

		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			if (!context.allowNetwork || context.signal?.aborted) return;

			const key = resolveApiKey(storedApiKey) || "";
			try {
				const result = await queryModels(baseUrl, key || "local");
				detectedApiType = result.apiType;
				models = result.models.map((m) => toModel(m, baseUrl, detectedApiType));
			} catch {
				// Keep existing cached models on failure
			}
		},

		stream: (model, context, options) => {
			const opts = options as ProviderStreamOptions | undefined;
			const level = opts?.reasoningEffort;
			return stream(
				adaptModelForRequest(
					model,
					typeof level === "string" ? level : undefined,
				),
				context,
				opts,
			);
		},

		streamSimple: (model, context, options) =>
			streamSimple(
				adaptModelForRequest(model, options?.reasoning),
				context,
				options,
			),
	};
}
