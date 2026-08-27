// ============================================================================
// API Response Types (from various local inference servers)
// ============================================================================

interface OmlxModelsStatusResponse {
	models: Array<{
		id: string;
		display_name?: string | null;
		model_alias?: string | null;
		max_context_window?: number;
		max_tokens?: number;
		enable_thinking?: boolean | null;
		thinking_default?: boolean | null;
		preserve_thinking_default?: boolean | null;
		reasoning_effort_options?: string[] | null;
		reasoning_effort_default?: string | null;
		model_type?: string | null;
		config_model_type?: string | null;
		loaded?: boolean;
		pinned?: boolean;
		is_favorite?: boolean;
		is_hidden?: boolean;
		estimated_size?: number;
	}>;
}

interface OmlxApiStatusResponse {
	default_model?: string;
	models_loaded?: number;
	models_loading?: number;
	models_discovered?: number;
	model_memory_used_formatted?: string;
	model_memory_max_formatted?: string;
	version?: string;
}

interface LmStudioModelsResponse {
	models: Array<{
		key: string;
		display_name?: string;
		architecture?: string;
		format?: string;
		loaded_instances?: unknown[];
		size_bytes?: number;
		type?: string;
		max_context_length?: number;
		publisher?: string;
		quantization?: { name: string };
		capabilities?: {
			vision?: boolean;
			trained_for_tool_use?: boolean;
			reasoning?: {
				allowed_options?: string[];
				default?: string;
			};
		};
	}>;
}

export interface OpenAIModelEntry {
	id: string;
	object?: string;
	/**
	 * Not in the OpenAI spec: llama.cpp describes the model here. `n_ctx` is
	 * the context window in tokens, `size` the model file in bytes. Other
	 * servers (vLLM, TF Serving, ...) omit `meta` entirely.
	 */
	meta?: { n_ctx?: number; size?: number };
	/**
	 * Also not in the OpenAI spec, and flat rather than under `meta`: vLLM's
	 * model card carries the context window here. The key is always present and
	 * null for LoRA adapters, whose context is their base model's (`parent`).
	 */
	max_model_len?: number | null;
	/** vLLM: id of the base model a LoRA adapter was trained from. */
	parent?: string | null;
}

interface OpenAIModelsResponse {
	object: string;
	data: OpenAIModelEntry[];
}

// ============================================================================
// Discovered Model (unified representation)
// apiType is NOT stored on models — it's determined per-query and may differ
// between runs if the server behind the endpoint changes.
// ============================================================================

export type ApiType = "omlx" | "lmstudio" | "openai";

export interface DiscoveredModel {
	id: string;
	displayName: string;
	description: string; // formatted display line for the menu
	loaded: boolean;
	contextWindow?: number;
	maxTokens?: number;
	modelType?: string;
	sizeBytes?: number;
	pinned?: boolean;
	favorite?: boolean;
	reasoning?: boolean;
	/** Strict reasoning_effort vocabulary advertised by the server (oMLX discovery). */
	reasoningEffortOptions?: string[];
	leftExtras?: string; // internal: quant/publisher for LM Studio display
}

export interface QueryResult {
	apiType: ApiType;
	models: DiscoveredModel[];
	status?: OmlxApiStatusResponse;
}

// ============================================================================
// Endpoint Querying (with fallback chain: omlx → lmstudio → openai)
// ============================================================================

async function queryOmlx(
	baseUrl: string,
	apiKey: string,
): Promise<QueryResult> {
	const [modelsRes, statusRes] = await Promise.all([
		fetchJson<OmlxModelsStatusResponse>(`${baseUrl}/v1/models/status`, apiKey),
		fetchJson<OmlxApiStatusResponse>(`${baseUrl}/api/status`, apiKey),
	]);

	if (!modelsRes?.models?.length) return { apiType: "omlx", models: [] };

	const status = statusRes ?? undefined;
	const models: DiscoveredModel[] = [];

	for (const entry of modelsRes.models) {
		if (!entry.id || !entry.model_type) continue;
		const type = entry.model_type.toLowerCase();
		if (type !== "llm" && type !== "vlm") continue;

		if (entry.is_hidden === true) continue;

		const alias = entry.model_alias || entry.display_name || entry.id;
		const configModelType = (entry.config_model_type || type).toLowerCase();

		const reasoning = entry.thinking_default != null ? true : undefined;
		const rawEffortOptions = entry.reasoning_effort_options;
		const reasoningEffortOptions =
			Array.isArray(rawEffortOptions) &&
			rawEffortOptions.length > 0 &&
			rawEffortOptions.every((o) => typeof o === "string")
				? rawEffortOptions
				: undefined;
		const modelType = [reasoning ? "🧠" : "🤖", type, configModelType]
			.filter(Boolean)
			.join("/");

		models.push({
			id: entry.id,
			displayName: alias,
			description: "", // filled after sorting
			loaded: entry.loaded === true,
			pinned: entry.pinned === true,
			favorite: entry.is_favorite === true,
			contextWindow: entry.max_context_window,
			maxTokens: entry.max_tokens,
			modelType: modelType,
			sizeBytes: entry.estimated_size,
			reasoning,
			reasoningEffortOptions,
		});
	}

	// Sort by display name (case-insensitive)
	models.sort((a, b) =>
		a.displayName.localeCompare(b.displayName, undefined, {
			sensitivity: "base",
		}),
	);

	// Build descriptions with right-aligned numeric fields
	for (const model of models) {
		const sizeGb = model.sizeBytes
			? `|${(model.sizeBytes / (1024 * 1024 * 1024)).toFixed(1).padStart(6)}G`
			: "      ";
		const ctx = model.contextWindow
			? `ctx:${Math.round(model.contextWindow / 1024)
					.toString()
					.padStart(4)}k`
			: "      ";
		const parts = [sizeGb, ctx];
		if (model.modelType) parts.push(model.modelType);
		model.description = parts.join(", ");
	}

	return { apiType: "omlx", models, status };
}

async function queryLmStudio(
	baseUrl: string,
	apiKey: string,
): Promise<QueryResult> {
	const res = await fetchJson<LmStudioModelsResponse>(
		`${baseUrl}/api/v1/models`,
		apiKey,
	);
	if (!res?.models?.length) return { apiType: "lmstudio", models: [] };

	const models: DiscoveredModel[] = [];

	for (const entry of res.models) {
		const rawType = (entry.type || "").toLowerCase();
		if (rawType !== "llm" && rawType !== "vlm") continue;

		const loaded = (entry.loaded_instances?.length ?? 0) > 0;
		const quant = entry.quantization?.name || "";
		const pub = entry.publisher || "";
		const leftExtras = [quant, pub].filter(Boolean).join("/");

		// Right column: format/type/architecture (pass through as-is, only lowercase type)
		const format = entry.format || "";
		const architecture = entry.architecture || "";
		const reasoning = entry.capabilities?.reasoning ? true : undefined;
		const modelType = [reasoning ? "🧠" : "🤖", format, rawType, architecture]
			.filter(Boolean)
			.join("/");

		// Append leftExtras to displayName so it appears in the label column
		const baseName = entry.display_name || entry.key;
		const displayName = leftExtras ? `${baseName} (${leftExtras})` : baseName;

		models.push({
			id: entry.key,
			displayName,
			description: "", // filled after sorting
			loaded,
			contextWindow: entry.max_context_length,
			modelType,
			sizeBytes: entry.size_bytes,
			reasoning,
		});
	}

	// Sort by display name (case-insensitive)
	models.sort((a, b) =>
		a.displayName.localeCompare(b.displayName, undefined, {
			sensitivity: "base",
		}),
	);

	// Build descriptions with right-aligned numeric fields
	for (const model of models) {
		const extras = (model as { leftExtras?: string }).leftExtras;
		const extrasStr = extras ? ` (${extras})` : "";
		const sizeGb = model.sizeBytes ? `|${formatBytes(model.sizeBytes)}` : "";
		const ctx = model.contextWindow
			? `ctx:${formatContext(model.contextWindow)}`
			: "";
		const parts: string[] = [];
		if (extrasStr) parts.push(extrasStr);
		parts.push(sizeGb, ctx);
		if (model.modelType) parts.push(model.modelType);
		model.description = parts.join(", ");
	}

	return { apiType: "lmstudio", models };
}

async function queryOpenAI(
	baseUrl: string,
	apiKey: string,
): Promise<QueryResult> {
	const res = await fetchJson<OpenAIModelsResponse>(
		`${baseUrl}/v1/models`,
		apiKey,
	);
	if (!res?.data?.length) return { apiType: "openai", models: [] };

	return { apiType: "openai", models: mapOpenAiModels(res.data) };
}

/**
 * Map a plain OpenAI-compatible /v1/models payload to discovered models.
 *
 * Two servers here report more than an id, and they disagree on where to put
 * it: llama.cpp nests a `meta` object (`n_ctx` in tokens, `size` in bytes),
 * vLLM puts the same quantity flat on the card as `max_model_len`. Both mean
 * "the context window this server will hold you to" — vLLM resolves its number
 * against the KV cache that actually fit, so it is the authoritative figure
 * even when the operator launched with a larger one. `size` is display-only.
 *
 * Servers advertising neither leave both undefined, so the right-hand column
 * of the model list stays blank (and provider.ts falls back to its default
 * context window).
 */
export function mapOpenAiModels(data: OpenAIModelEntry[]): DiscoveredModel[] {
	const models: DiscoveredModel[] = [];
	// LoRA cards report no context of their own, so keep the lineage and the
	// base models' contexts around to fill them in from. `parent` always names a
	// base model, never another adapter, so one lookup is all it takes.
	const contexts = new Map<string, number>();
	const parents = new Map<string, string>();

	for (const entry of data) {
		if (!entry || typeof entry.id !== "string") continue;
		const model: DiscoveredModel = {
			id: entry.id,
			displayName: entry.id,
			description: "", // filled below, once every field is known
			loaded: false,
			// `meta` first: llama.cpp is the incumbent and its reading is
			// unchanged by the vLLM field, which no llama.cpp build emits.
			contextWindow:
				positiveNumber(entry.meta?.n_ctx) ??
				positiveNumber(entry.max_model_len),
			sizeBytes: positiveNumber(entry.meta?.size),
		};
		if (model.contextWindow) contexts.set(model.id, model.contextWindow);
		if (typeof entry.parent === "string" && entry.parent)
			parents.set(model.id, entry.parent);
		models.push(model);
	}

	for (const model of models) {
		if (!model.contextWindow) {
			const parent = parents.get(model.id);
			if (parent) model.contextWindow = contexts.get(parent);
		}
		model.description = formatModelColumn(model);
	}
	return models;
}

// ============================================================================
// Main Query (with fallback chain)
// ============================================================================

export async function queryConnection(
	baseUrl: string,
	apiKey: string,
): Promise<QueryResult> {
	// Try oMLX first
	let result = await queryOmlx(baseUrl, apiKey);
	if (result.models.length > 0) return result;

	// Try LM Studio
	result = await queryLmStudio(baseUrl, apiKey);
	if (result.models.length > 0) return result;

	// Fall back to OpenAI
	return queryOpenAI(baseUrl, apiKey);
}

// ============================================================================
// Load / Unload Operations
// ============================================================================

export async function loadModel(
	baseUrl: string,
	apiKey: string,
	modelId: string,
	apiType: ApiType,
): Promise<unknown> {
	switch (apiType) {
		case "omlx":
			return execApi(
				`${baseUrl}/admin/api/models/${modelId}/load`,
				apiKey,
				"POST",
				{},
			);
		case "lmstudio":
			return execApi(`${baseUrl}/api/v1/models/load`, apiKey, "POST", {
				model: modelId,
			});
		case "openai":
			return { error: "load not supported" };
	}
}

export async function unloadModel(
	baseUrl: string,
	apiKey: string,
	modelId: string,
	apiType: ApiType,
): Promise<unknown> {
	switch (apiType) {
		case "omlx":
			return execOmlxUnload(baseUrl, apiKey, modelId);
		case "lmstudio":
			return execApi(`${baseUrl}/api/v1/models/unload`, apiKey, "POST", {
				instance_id: modelId,
			});
		case "openai":
			return { error: "unload not supported" };
	}
}

async function execOmlxUnload(
	baseUrl: string,
	apiKey: string,
	modelId: string,
): Promise<unknown> {
	// Login to get session cookie
	const loginRes = await fetch(`${baseUrl}/admin/api/login`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ api_key: apiKey }),
	});
	const setCookie = loginRes.headers
		.get("set-cookie")
		?.match(/omlx_admin_session=([^;]*)/i)?.[1];
	if (!setCookie) return { error: "failed to get session cookie" };

	const res = await fetch(`${baseUrl}/admin/api/models/${modelId}/unload`, {
		method: "POST",
		headers: { Cookie: `omlx_admin_session=${setCookie}` },
	});
	if (!res.ok) return { error: `HTTP ${res.status}` };
	return res.json();
}

// ============================================================================
// Helpers
// ============================================================================

async function fetchJson<T>(
	url: string,
	apiKey: string,
	timeoutMs = 5000,
): Promise<T | null> {
	const signal = AbortSignal.timeout(timeoutMs);
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal,
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

async function execApi(
	url: string,
	apiKey: string,
	method = "POST",
	body?: unknown,
): Promise<unknown> {
	try {
		const res = await fetch(url, {
			method,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			...(body !== undefined && { body: JSON.stringify(body) }),
		});
		return res.ok ? res.json() : { error: `HTTP ${res.status}` };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

function formatBytes(bytes: number): string {
	return `${((bytes / (1024 * 1024 * 1024)).toFixed(1)).padStart(6)}G`;
}

function formatContext(tokens: number): string {
	return `${Math.round(tokens / 1024)
		.toString()
		.padStart(4)}k`;
}

/**
 * Right-hand column of the model list for servers that report no more than
 * OpenAI's `/v1/models` requires: `|  88.0G, ctx:  256k`, same field widths as
 * the oMLX backend. Fields that are missing are left out; when both are the
 * column is empty.
 */
function formatModelColumn(model: DiscoveredModel): string {
	const parts: string[] = [];
	if (model.sizeBytes) parts.push(`|${formatBytes(model.sizeBytes)}`);
	if (model.contextWindow)
		parts.push(`ctx:${formatContext(model.contextWindow)}`);
	return parts.join(", ");
}

/**
 * Numeric field from an unvalidated server response.
 *
 * These endpoints are third-party and loose with their own shapes — llama.cpp
 * itself returns `size: ""` (a string) in the sibling `models` array of the
 * very same response — so anything but a positive finite number counts as
 * absent.
 */
function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}
