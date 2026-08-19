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
] as const;

/**
 * Build a thinkingLevelMap for a server that advertises a strict
 * reasoning_effort vocabulary (oMLX discovery, /v1/models/status).
 *
 * Advertised levels that match pi's built-ins map to themselves; the rest
 * are hidden (null). "off" maps to "none", which oMLX translates to
 * enable_thinking: false. Returns undefined when the advertised vocabulary
 * doesn't overlap any pi level (caller falls back to the boolean toggle).
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
	if (matched === 0) return undefined;
	map.off = "none";
	return map;
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
		// oMLX discovery: the server advertises the chat template's strict
		// reasoning_effort vocabulary → use the standard top-level field and
		// let pi's generic reasoning_effort branch do the mapping.
		thinkingLevelMap = m.reasoningEffortOptions
			? buildThinkingLevelMap(m.reasoningEffortOptions)
			: undefined;
		if (thinkingLevelMap) {
			// Harmless on current pi (detection already assumes it for local
			// servers), but makes the model self-describing.
			compat = { supportsReasoningEffort: true };
		} else if (m.reasoning) {
			// Fallback (server doesn't advertise a vocabulary):
			// boolean thinking toggle via chat template kwargs.
			compat = { thinkingFormat: "qwen-chat-template" as const };
		}
		// LM Studio and generic OpenAI servers: no thinkingFormat for now
		// (they may not support per-request thinking control via the API)
	}
	// The generic reasoning_effort branch only fires when model.reasoning is
	// set, so a built map implies reasoning support.
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
		input: m.modelType?.includes("vlm") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
	};
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
					if (!key || !key.trim()) {
						key = resolveApiKey(storedApiKey);
					}
					if (!key || !key.trim()) {
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

		stream: (model, context, options) =>
			stream(model, context, options as ProviderStreamOptions | undefined),

		streamSimple: (model, context, options) =>
			streamSimple(model, context, options),
	};
}
