import type {
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Model,
	Provider,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import type { ProviderStreamOptions } from "@earendil-works/pi-ai/compat";
import type { DiscoveredModel, QueryResult } from "./model-picker.ts";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

/**
 * Human-readable display name for a base URL provider.
 * Strips protocol and trailing slash: "http://127.0.0.1:1234" → "127.0.0.1:1234"
 */
export function providerDisplayName(baseUrl: string): string {
	return baseUrl.replace(/^https?:\/\//, "").replace(/\/?$/, "");
}

function toModel(
	m: DiscoveredModel,
	providerId: string,
): Model<"openai-completions"> {
	return {
		id: m.id,
		name: m.displayName,
		api: "openai-completions",
		provider: providerId,
		baseUrl: `${providerId}/v1`,
		reasoning: m.reasoning ?? false,
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
 * @param baseUrl         The server base URL (also used as provider id)
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

	return {
		id: baseUrl,
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
				}: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthResult | undefined> => {
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
				models = result.models.map((m) => toModel(m, baseUrl));
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
