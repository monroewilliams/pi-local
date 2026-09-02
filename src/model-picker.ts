import { describeThinking } from "./thinking.ts";

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
		thinking_default?: boolean | null;
		preserve_thinking_default?: boolean | null;
		reasoning_effort_options?: string[] | null;
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
	meta?: {
		n_ctx?: number;
		size?: number;
	};
	/**
	 * Also not in the OpenAI spec, and flat rather than under `meta`: vLLM's
	 * model card carries the context window here. The key is always present and
	 * null for LoRA adapters, whose context is their base model's (`parent`).
	 */
	max_model_len?: number | null;
	/** vLLM: id of the base model a LoRA adapter was trained from. */
	parent?: string | null;
	/**
	 * llama-swap: the operator's `name:` for this model, echoed on every card
	 * including its aliases. Absent when the config left it unset, which is
	 * most configs — fall back to `id`.
	 */
	name?: string;
	/**
	 * llama-swap: live process state, `{"value":"loaded"|"unloaded"}`. Unlike
	 * everything else on this card it is not config — it reflects whether the
	 * backing server process is up right now. A selector reports `loaded` when
	 * any of its targets is ready.
	 */
	status?: { value?: string };
	/**
	 * llama-swap: derived from the operator's `capabilities:` block. Only `vision`
	 * is read — the block also carries `function_calling` and `reranker`, and
	 * `supported_parameters` sits beside it, but pi's `Model` has no slot for
	 * either. Keys are only ever emitted when true, so an absent `vision` means
	 * "not advertised", not "text-only".
	 */
	capabilities?: { vision?: boolean };
	/**
	 * llama-swap: the same `capabilities.in`, as a modality list. Read as the
	 * fallback when `capabilities` is absent entirely.
	 */
	architecture?: { input_modalities?: string[] };
	/**
	 * Who serves this card: `"llama-swap"`, `"vllm"`, `"llama.cpp"`. Read to
	 * recognise llama-swap out of the generic OpenAI tier, which is the only
	 * way to know that load/unload are available on it.
	 */
	owned_by?: string;
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

export type ApiType = "omlx" | "lmstudio" | "llamaswap" | "openai";

/**
 * Whether this server exposes load/unload controls worth showing.
 *
 * The generic OpenAI path does not: a bare `/v1/models` server offers nothing
 * to call. llama-swap does, in its own way — dispatch to load, a named
 * endpoint to unload — so it qualifies even though it answers the generic
 * listing.
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
	 * Accepts image input, read straight off the server's modality advertisement
	 * rather than inferred from `modelType`. `modelType` is set alongside it
	 * where a type is implied, because the cached-model path in index.ts restores
	 * `modelType` but not `vision` — both readings keep a multimodal model
	 * multimodal across a restart.
	 */
	vision?: boolean;
	sizeBytes?: number;
	pinned?: boolean;
	favorite?: boolean;
	reasoning?: boolean;
	/** Strict reasoning_effort vocabulary advertised by the server (oMLX discovery). */
	reasoningEffortOptions?: string[];
	/**
	 * Template default for `enable_thinking`, present when the template has that
	 * knob. Carried separately from `reasoning` because the two answer different
	 * questions: `reasoning` is "can it think", this is "does it take
	 * enable_thinking". A GLM-family model thinks through `clear_thinking` and
	 * leaves this absent.
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

		const thinking = describeThinking(entry);
		// pi gates the whole thinking control on `reasoning`, so it stays true for
		// every oMLX model. Whether a model thinks is settled by what the user
		// observes, not by a pattern match on its template: Nemotron-3.5-Lightning
		// answers to the toggle while its template names no levels, so any badge
		// this code could draw would be a guess in both directions. The picker
		// therefore shows the model type alone and lets the ladder speak for itself.
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
		// No capability badge. LM Studio does advertise `capabilities.reasoning`,
		// so this one would have been the server's claim rather than ours — say the
		// word if you want it back. The column carries the model's shape instead.
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

	// llama-swap stamps `owned_by: "llama-swap"` on every card it serves, so
	// the listing we already fetched identifies it — no extra probe. Knowing it
	// is llama-swap buys load/unload, which the generic path has neither.
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
 * Three servers here report more than an id, and they disagree on where to put
 * it: llama.cpp nests a `meta` object (`n_ctx` in tokens, `size` in bytes),
 * vLLM puts the same quantity flat on the card as `max_model_len`, llama-swap
 * mirrors it into `context_length`/`context_window`/`meta.n_ctx` and adds the
 * operator's `name`, live `status` and `capabilities`. The context figures all
 * mean "the window this server will hold you to" — vLLM resolves its number
 * against the KV cache that actually fit, so it is the authoritative figure even
 * when the operator launched with a larger one; llama-swap's is whatever the
 * operator declared in `capabilities.context`, which is the number to honour
 * since llama-swap is the thing answering the request. `size` is display-only.
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
		const vision = advertisedVision(entry);
		const model: DiscoveredModel = {
			id: entry.id,
			// llama-swap's `name` is the operator's own label; every other server
			// in this path omits it and shows its id.
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
			// dispatches — a GET that asks for properties, so no tokens are
			// generated, and the process is up and health-checked by the time it
			// returns (~0.3s here, plus however long the model takes to load).
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
 * Returns `{ ok: true }` on any 2xx without touching the body — llama-swap's
 * unload answers `OK` as plain text, and parsing it as JSON would turn a
 * successful unload into a reported failure.
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
 * A 404 here is ambiguous and the two cases are told apart by who answered:
 * llama-swap's own rejections are its OpenAI-shaped error envelope
 * (`{"src":"llama-swap",...}`), while a 404 from the upstream arrives after
 * the model is already loaded — `/props` is a llama.cpp route, so vLLM and
 * friends do not implement it, and the load still happened. Only the first is
 * a failure; the second is reported as success and the caller's refresh shows
 * the state.
 *
 * No timeout: this blocks while a model loads, which can be minutes for a
 * large one, and the picker is showing "Loading" the whole time.
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
		// `own` is the only real failure: llama-swap could not route the model.
		// Any other status — including an upstream's 404 for a route it does not
		// implement — arrives after the dispatch, so the model is loaded and the
		// caller's refresh is what the user judges by.
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
 * without that `src` came from the upstream, which is the discriminator that
 * separates "this model does not exist" from "this model exists and answered
 * with something we did not expect".
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
		/* not JSON — an upstream or proxy error page */
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
 * llama-swap emits `capabilities.vision` only when true (it is written out of
 * `capabilities.in`, never as an explicit false), so an absent key cannot be
 * read as text-only — hence the fallback to the modality lists, which are the
 * same config rendered the other way and *do* carry `text` on its own.
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
 * the oMLX backend. Fields that are missing are left out; when both are the
 * column is empty.
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
