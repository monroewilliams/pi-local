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
 * Build a thinkingLevelMap for a server that advertises a fixed
 * reasoning_effort vocabulary (oMLX /v1/models/status).
 *
 * Output is ordered by pi's ladder, not the server's: a template that lists its
 * levels `high, low` would otherwise put high first in the menu. Levels pi has
 * no name for are set to null, which hides them. "none", how oMLX spells off,
 * maps to `off`.
 *
 * Returns undefined when fewer than two pi levels match. One entry is not a
 * menu: gpt-oss advertises exactly ["medium"], and pinning the selector to a
 * choice the server ignores is worse than the plain on/off toggle.
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
 * The full pi ladder, sent verbatim as top-level `reasoning_effort`, with
 * `off` mapped to "none".
 *
 * pi only offers `xhigh` and `max` when a model maps them, so an unmapped model
 * stops at `high`. This map removes that ceiling for servers that accept the
 * whole vocabulary.
 *
 * llama.cpp forwards the string to the chat template and ignores it when the
 * template does not read `reasoning_effort`. oMLX does the same for a model
 * that advertises no vocabulary, since no vocabulary means no whitelist.
 *
 * "none" turns thinking off: llama.cpp converts it to
 * `enable_thinking = false` and drops the kwarg.
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
		// pi's thinkingFormat selects exactly one wire shape (openai-completions.js:
		// the chat-template branch emits reasoning_effort from $var, the
		// qwen-chat-template branch emits none), so the effort vocabulary and the
		// enable_thinking toggle are chosen between, never combined.
		//
		// oMLX advertises an effort vocabulary only when the template consumes
		// reasoning_effort, so the two cases do not overlap in practice.
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
			// no effort values.
			//
			// chat-template, not qwen-chat-template. Both write chat_template_kwargs
			// and $var:thinking.enabled resolves to the same !!reasoningEffort, but
			// qwen-chat-template hardcodes `preserve_thinking: true` and would
			// override a template that clears history by default. preserve_thinking
			// is passed only when oMLX reported it, so the server default stands
			// otherwise. No omitWhenOff: a template that thinks unless told not to
			// has to receive an explicit false.
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
				// No vocabulary and no enable_thinking switch, so effort is the only
				// channel left. gpt-oss lands here: one level is not a menu.
				compat = { supportsReasoningEffort: true };
			}
		}
	} else if (
		apiType === undefined ||
		apiType === "openai" ||
		apiType === "llamaswap" ||
		apiType === "lmstudio"
	) {
		// Unknown engine. llama.cpp lands here because its /v1/models says nothing
		// about reasoning. No per-format thinkingFormat, so pi takes the
		// OpenAI-generic branch: the selected level goes out as top-level
		// `reasoning_effort`, "none" to disable thinking.
		//
		// llama-swap belongs here too. It rewrites only `model` in the request body
		// and forwards `reasoning_effort` and `chat_template_kwargs` unchanged, so
		// thinking behaves like whatever engine is behind it.
		//
		// LM Studio as well. Its `capabilities.reasoning` does name a vocabulary,
		// but in a full HF cache the only model that populates it answers
		// ["off", "on"]. Honouring that would cap every LM Studio model at what one
		// GGUF reported, and the full map already covers a two-position switch.
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
 * The format is decided at discovery, since it follows from the model rather
 * than the selected level.
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
