import type { Model } from "@earendil-works/pi-ai";
import { streamSimpleOpenAICompletions } from "@earendil-works/pi-ai";
import type {
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { DiscoveredModel } from "./model-picker";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

/**
 * Build a ProviderConfig for a single connection.
 *
 * The apiKey is passed as a !command string (or direct key / env var).
 * The Pi SDK resolves it via resolveConfigValueOrThrow at request time
 * (model-registry.ts:763).
 *
 * This is the same mechanism used by built-in providers for shell-command
 * based API key retrieval.
 */
export function toProviderConfig(
	models: DiscoveredModel[],
	baseUrl: string,
	apiKeyCommand: string,
): ProviderConfig {
	return {
		baseUrl: `${baseUrl}/v1`,
		apiKey: apiKeyCommand,
		api: "openai-completions",
		authHeader: true,
		streamSimple: (model, context, options) =>
			streamSimpleOpenAICompletions(
				model as Model<"openai-completions">,
				context,
				options,
			),
		models: models.map(toProviderModel),
	};
}

function toProviderModel(m: DiscoveredModel): ProviderModelConfig {
	return {
		id: m.id,
		name: m.displayName,
		reasoning: m.reasoning ?? false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
	};
}
