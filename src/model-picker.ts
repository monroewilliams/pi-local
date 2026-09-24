import { describeThinking } from "./thinking.ts";

// ============================================================================
// API Response Types (from various local inference servers)
// ============================================================================

interface OmlxModelsStatusResponse {
	models: Array<{
		id: string;
		model_alias?: string | null;
		max_context_window?: number;
		max_tokens?: number;
		thinking_default?: boolean | null;
		preserve_thinking_default?: boolean | null;
		reasoning_effort_options?: string[] | null;
		model_type?: string | null;
		config_model_type?: string | null;
		loaded?: boolean;
		pinned?: boolean;
		is_favorite?: boolean;
		is_hidden?: boolean;
		is_helper?: boolean;
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
	 * Not in the OpenAI spec. llama.cpp describes the model here: `n_ctx` is the
	 * context window in tokens, `size` the model file in bytes. vLLM and other
	 * servers omit `meta`.
	 */
	meta?: {
		n_ctx?: number;
		size?: number;
	};
	/**
	 * Not in the OpenAI spec, and flat rather than under `meta`. vLLM carries the
	 * context window here. The key is always present and null for LoRA adapters,
	 * whose context is their base model's (`parent`).
	 */
	max_model_len?: number | null;
	/** vLLM: id of the base model a LoRA adapter was trained from. */
	parent?: string | null;
	/**
	 * llama-swap: the operator's `name:` for this model, on every card including
	 * its aliases. The field is omitted when the config leaves it unset, so fall
	 * back to `id`.
	 */
	name?: string;
	/**
	 * llama-swap: live process state, `{"value":"loaded"|"unloaded"}`. The rest of
	 * the card is config; this is whether the backing process is up now. A
	 * selector reports `loaded` when any of its targets is ready.
	 */
	status?: { value?: string };
	/**
	 * llama-swap: derived from the operator's `capabilities:` block. Only `vision`
	 * is read; the block also carries `function_calling` and `reranker`, which pi
	 * has no field for. Keys appear only when true, so an absent `vision` means
	 * "not advertised", not "text-only".
	 */
	capabilities?: { vision?: boolean };
	/**
	 * llama-swap: the same `capabilities.in` as a modality list. Read when
	 * `capabilities` is absent.
	 */
	architecture?: { input_modalities?: string[] };
	/**
	 * Who serves this card: `"llama-swap"`, `"vllm"`, `"llamacpp"`. Read to pick
	 * llama-swap out of the generic tier, which is how load and unload become
	 * available on it.
	 */
	owned_by?: string;
}

interface OpenAIModelsResponse {
	object: string;
	data: OpenAIModelEntry[];
}

// ============================================================================
// Discovered Model (unified representation)
// apiType is NOT stored on models. It is determined per-query and can differ
// between runs if the server behind the endpoint changes.
// ============================================================================

export type ApiType = "omlx" | "lmstudio" | "llamaswap" | "openai";

/**
 * Whether this server exposes load/unload controls worth showing.
 *
 * The generic OpenAI path does not: a bare `/v1/models` server offers nothing to
 * call. llama-swap does, by dispatching to load and by a named unload endpoint,
 * so it qualifies even though it answers the generic listing.
 */
export function supportsLoadUnload(apiType: ApiType): boolean {
	return (
		apiType === "omlx" || apiType === "lmstudio" || apiType === "llamaswap"
	);
}

export interface DiscoveredModel {
	id: string;
	displayName: string;
	description: string; // formatted display line for the menu
	loaded: boolean;
	contextWindow?: number;
	maxTokens?: number;
	modelType?: string;
	/**
	 * Accepts image input. Read off the server's modality advertisement rather
	 * than inferred from `modelType`. Both are set where a type is implied,
	 * because the cached-model path in index.ts restores `modelType` but not
	 * `vision`.
	 */
	vision?: boolean;
	sizeBytes?: number;
	pinned?: boolean;
	favorite?: boolean;
	reasoning?: boolean;
	/** Effort vocabulary advertised by the server. Pending oMLX PR; absent today. */
	reasoningEffortOptions?: string[];
	/**
	 * Template default for `enable_thinking`, present when the template has that
	 * knob. Separate from `reasoning`: that asks "can it think", this asks "does
	 * it take enable_thinking". A model that thinks through `clear_thinking` has
	 * this absent.
	 */
	thinkingDefault?: boolean;
	/** Template default for `preserve_thinking` / inverse of `clear_thinking`. */
	preserveThinkingDefault?: boolean;
	leftExtras?: string; // internal: quant/publisher for LM Studio display
}

export interface QueryResult {
	apiType: ApiType;
	models: DiscoveredModel[];
	status?: OmlxApiStatusResponse;
}

/**
 * Whether a model goes in the top block of the list: the operator starred it or
 * pinned it. Both are set by hand and stay set, so ranking on them is stable.
 * `loaded` is excluded: it flips while the picker is open, under the `l` and `u`
 * keys.
 */
function isSticky(m: DiscoveredModel): boolean {
	return m.favorite === true || m.pinned === true;
}

/**
 * Order the list the way every picker here shows it: pinned and favorited
 * models as one block at the top, everything else after, each block by display
 * name case-insensitively. Sorts in place and returns the same array.
 *
 * The two marks share a block instead of ranking against each other. Backends
 * that report neither flag get plain name order.
 */
export function sortModelsForDisplay(
	models: DiscoveredModel[],
): DiscoveredModel[] {
	return models.sort((a, b) => {
		const aSticky = isSticky(a);
		const bSticky = isSticky(b);
		if (aSticky !== bSticky) return aSticky ? -1 : 1;
		return a.displayName.localeCompare(b.displayName, undefined, {
			sensitivity: "base",
		});
	});
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
		// oMLX flags speculative-decoding drafters (DFlash, MTP heads, assistant
		// models) with is_helper whether or not hide_helper_models is on. They pass
		// the llm/vlm check but fail to load as chat models.
		if (entry.is_helper === true) continue;

		// The operator's alias when one is set, else the id.
		const alias = entry.model_alias || entry.id;
		const configModelType = (entry.config_model_type || type).toLowerCase();

		const thinking = describeThinking(entry);
		// pi gates the whole thinking control on `reasoning`, so it stays true for
		// every oMLX model. No badge is drawn: a template that names no levels can
		// still answer to the toggle, so any badge would be a guess either way.
		const reasoning = true;
		const reasoningEffortOptions =
			thinking.effortOptions.length > 0 ? thinking.effortOptions : undefined;
		const modelType = [type, configModelType].filter(Boolean).join("/");

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
			thinkingDefault: thinking.thinkingDefault,
			preserveThinkingDefault: thinking.preserveThinkingDefault,
		});
	}

	sortModelsForDisplay(models);

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
		// No capability badge. LM Studio advertises `capabilities.reasoning`, so
		// this one would have been the server's claim rather than ours.
		const modelType = [format, rawType, architecture].filter(Boolean).join("/");

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

	sortModelsForDisplay(models);

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

	// llama-swap stamps `owned_by: "llama-swap"` on every card, so the listing
	// already fetched identifies it without a second probe. Knowing it is
	// llama-swap is what makes load and unload available here.
	const isLlamaSwap = res.data.some(
		(entry) => entry?.owned_by === "llama-swap",
	);

	return {
		apiType: isLlamaSwap ? "llamaswap" : "openai",
		models: mapOpenAiModels(res.data),
	};
}

/**
 * Map a plain OpenAI-compatible /v1/models payload to discovered models.
 *
 * Three servers report more than an id and disagree on where the context window
 * goes: llama.cpp nests it in `meta.n_ctx`, vLLM puts it flat on the card as
 * `max_model_len`, llama-swap mirrors one number into `context_length`,
 * `context_window` and `meta.n_ctx` and adds the operator's `name`, live
 * `status` and `capabilities`. `meta.n_ctx` is tried first so llama.cpp is
 * unaffected by the others. `size` is display-only.
 *
 * A server that reports neither leaves the right-hand column blank, and
 * provider.ts falls back to its default context window.
 */
export function mapOpenAiModels(data: OpenAIModelEntry[]): DiscoveredModel[] {
	const models: DiscoveredModel[] = [];
	// LoRA cards report no context of their own. Keep the base models' contexts
	// and the parent links to fill them in from. `parent` names a base model and
	// never another adapter, so one lookup is enough.
	const contexts = new Map<string, number>();
	const parents = new Map<string, string>();

	for (const entry of data) {
		if (!entry || typeof entry.id !== "string") continue;
		const vision = advertisedVision(entry);
		const model: DiscoveredModel = {
			id: entry.id,
			// llama-swap's `name` is the operator's label. Other servers on this
			// path omit it and show the id.
			displayName: entry.name?.trim() || entry.id,
			description: "", // filled below, once every field is known
			// llama-swap only; llama.cpp and vLLM send no `status`, and a card
			// that does not say "loaded" is not claimed to be one.
			loaded: entry.status?.value === "loaded",
			// `meta` first: llama.cpp is the incumbent and its reading is
			// unchanged by the vLLM field, which no llama.cpp build emits.
			contextWindow:
				positiveNumber(entry.meta?.n_ctx) ??
				positiveNumber(entry.max_model_len),
			sizeBytes: positiveNumber(entry.meta?.size),
			vision,
			// Only a server that states a modality gets a type; an unmodality-
			// aware card keeps the column blank rather than guessing "llm".
			modelType: vision === undefined ? undefined : vision ? "vlm" : "llm",
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
		case "llamaswap":
			// llama-swap has no load endpoint: dispatching a request to a model is
			// what swaps its server in. `/props?model=` is the cheapest route that
			// dispatches: a GET for properties, so no tokens are generated, and the
			// process is up and health-checked by the time it returns.
			return execLlamaSwapLoad(baseUrl, apiKey, modelId);
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
		case "llamaswap":
			// Answers 200 with the plain text "OK", not JSON, so nothing here may
			// assume a body. Selectors are not processes and answer 404; the caller
			// re-queries either way, and the refreshed listing is the truth.
			return execExpectOk(
				`${baseUrl}/api/models/unload/${encodeURIComponent(modelId)}`,
				apiKey,
				"POST",
			);
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

/**
 * Fire a request whose job is the side effect, not the response.
 *
 * Returns `{ ok: true }` on any 2xx without reading the body. llama-swap's
 * unload answers `OK` as plain text, and parsing that as JSON would report a
 * successful unload as a failure.
 */
async function execExpectOk(
	url: string,
	apiKey: string,
	method = "POST",
): Promise<unknown> {
	try {
		const res = await fetch(url, {
			method,
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (res.ok) return { ok: true };
		return { error: (await llamaSwapOwnError(res)) ?? `HTTP ${res.status}` };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Start a model's server by dispatching `/props?model=` at it.
 *
 * A 404 here is ambiguous, and who answered settles it. llama-swap's own
 * rejections carry its OpenAI-shaped envelope (`{"src":"llama-swap",...}`) and
 * mean the model could not be routed. A 404 from the upstream arrives after the
 * dispatch, so the model did load: `/props` is a llama.cpp route and vLLM and
 * others do not implement it. Only the first is a failure.
 *
 * No timeout. This blocks while the model loads, which is minutes for a large
 * one.
 */
async function execLlamaSwapLoad(
	baseUrl: string,
	apiKey: string,
	modelId: string,
): Promise<unknown> {
	try {
		const res = await fetch(
			`${baseUrl}/props?model=${encodeURIComponent(modelId)}`,
			{ headers: { Authorization: `Bearer ${apiKey}` } },
		);
		const own = await llamaSwapOwnError(res);
		// Anything that is not llama-swap's own rejection means the dispatch
		// happened, so the model is loaded.
		if (own) return { error: own };
		return { ok: true };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * The message from llama-swap's own error envelope, or `null` if this response
 * did not come from it.
 *
 * Its rejections are `{"src":"llama-swap","error":{"message":...}}`. A body
 * without that `src` came from the upstream, which is what separates "model
 * does not exist" from "model exists and answered unexpectedly".
 */
async function llamaSwapOwnError(res: Response): Promise<string | null> {
	if (res.ok) return null;
	let text = "";
	try {
		text = await res.text();
	} catch {
		return null; // body unreadable: not evidence of anything
	}
	try {
		const parsed = JSON.parse(text) as {
			src?: string;
			error?: { message?: string };
		};
		if (parsed?.src === "llama-swap") {
			return parsed.error?.message || "llama-swap rejected the request";
		}
	} catch {
		/* not JSON: an upstream or proxy error page */
	}
	return null;
}

function formatBytes(bytes: number): string {
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1).padStart(6)}G`;
}

function formatContext(tokens: number): string {
	return `${Math.round(tokens / 1024)
		.toString()
		.padStart(4)}k`;
}

/**
 * Whether a card advertises image input, or `undefined` when it says nothing
 * about modality.
 *
 * llama-swap emits `capabilities.vision` only when true (it comes from
 * `capabilities.in` and is never written as an explicit false), so an absent
 * key is not evidence of text-only. The modality list is the fallback, and it
 * does carry `text` on its own.
 */
function advertisedVision(entry: OpenAIModelEntry): boolean | undefined {
	if (entry.capabilities?.vision === true) return true;
	const inputs = entry.architecture?.input_modalities;
	if (Array.isArray(inputs)) return inputs.includes("image");
	return undefined;
}

/**
 * Right-hand column of the model list for servers that report no more than
 * OpenAI's `/v1/models` requires: `|  88.0G, ctx:  256k`, same field widths as
 * oMLX. Missing fields are left out; when all are missing the column is empty.
 */
function formatModelColumn(model: DiscoveredModel): string {
	const parts: string[] = [];
	if (model.sizeBytes) parts.push(`|${formatBytes(model.sizeBytes)}`);
	if (model.contextWindow)
		parts.push(`ctx:${formatContext(model.contextWindow)}`);
	if (model.modelType) parts.push(model.modelType);
	return parts.join(", ");
}

/**
 * Numeric field from an unvalidated server response. These endpoints are
 * third-party and loose with their own shapes, so only a positive finite number
 * counts as present.
 */
function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}
