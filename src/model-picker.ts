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
		model_type?: string | null;
		loaded?: boolean;
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

interface OpenAIModelsResponse {
	object: string;
	data: Array<{ id: string; object?: string }>;
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
	reasoning?: boolean;
}

export interface PickerResult {
	model: DiscoveredModel;
	action: "select" | "load" | "unload";
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

		const alias = entry.model_alias || entry.display_name || entry.id;
		const sizeGb = entry.estimated_size
			? `, ${formatBytes(entry.estimated_size)}`
			: "";
		const ctx = entry.max_context_window
			? `, ctx:${formatContext(entry.max_context_window)}`
			: "";
		const icon = entry.loaded ? "✅" : "  ";

		const reasoning = entry.thinking_default === true ? true : undefined;

		models.push({
			id: entry.id,
			displayName: alias,
			description: `${icon}${alias}${sizeGb}${ctx}, ${type}`,
			loaded: entry.loaded === true,
			contextWindow: entry.max_context_window,
			maxTokens: entry.max_tokens,
			modelType: type,
			sizeBytes: entry.estimated_size,
			reasoning,
		});
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
		const type = (entry.type || "").toLowerCase();
		if (type !== "llm" && type !== "vlm") continue;

		const loaded = (entry.loaded_instances?.length ?? 0) > 0;
		const quant = entry.quantization ? `${entry.quantization.name}/` : "";
		const arch = entry.architecture ? `${quant}${entry.architecture}` : quant;
		const pub = entry.publisher ? `/${entry.publisher}` : "";
		const sizeGb = entry.size_bytes ? `, ${formatBytes(entry.size_bytes)}` : "";
		const ctx = entry.max_context_length
			? `, ctx:${formatContext(entry.max_context_length)}`
			: "";
		const icon = loaded ? "✅" : "  ";

		const reasoning = entry.capabilities?.reasoning ? true : undefined;

		models.push({
			id: entry.key,
			displayName: entry.display_name || entry.key,
			description: `${icon}${entry.display_name || entry.key} (${arch}${pub})${sizeGb}${ctx}`,
			loaded,
			contextWindow: entry.max_context_length,
			modelType: type,
			sizeBytes: entry.size_bytes,
			reasoning,
		});
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

	return {
		apiType: "openai",
		models: res.data
			.filter((e): e is { id: string } => !!e && typeof e.id === "string")
			.map((e) => ({
				id: e.id,
				displayName: e.id,
				description: e.id,
				loaded: false,
			})),
	};
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
): Promise<boolean> {
	switch (apiType) {
		case "omlx":
			return execApi(
				`${baseUrl}/admin/api/models/${modelId}/load`,
				apiKey,
				"POST",
			);
		case "lmstudio":
			return execJsonApi(`${baseUrl}/api/v1/models/load`, apiKey, "POST", {
				model: modelId,
			});
		case "openai":
			return false; // load not supported
	}
}

export async function unloadModel(
	baseUrl: string,
	apiKey: string,
	modelId: string,
	apiType: ApiType,
): Promise<boolean> {
	switch (apiType) {
		case "omlx":
			// oMLX unload needs a session cookie from login
			return execOmlxUnload(baseUrl, apiKey, modelId);
		case "lmstudio":
			return execJsonApi(`${baseUrl}/api/v1/models/unload`, apiKey, "POST", {
				instance_id: modelId,
			});
		case "openai":
			return false;
	}
}

async function execOmlxUnload(
	baseUrl: string,
	apiKey: string,
	modelId: string,
): Promise<boolean> {
	// Login to get session cookie
	const loginRes = await fetch(`${baseUrl}/admin/api/login`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ api_key: apiKey }),
	});
	const setCookie = loginRes.headers
		.get("set-cookie")
		?.match(/omlx_admin_session=([^;]*)/i)?.[1];
	if (!setCookie) return false;

	const res = await fetch(`${baseUrl}/admin/api/models/${modelId}/unload`, {
		method: "POST",
		headers: { Cookie: `omlx_admin_session=${setCookie}` },
	});
	return res.ok;
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
): Promise<boolean> {
	try {
		const res = await fetch(url, {
			method,
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function execJsonApi(
	url: string,
	apiKey: string,
	method: string,
	body: unknown,
): Promise<boolean> {
	try {
		const res = await fetch(url, {
			method,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
		});
		return res.ok;
	} catch {
		return false;
	}
}

function formatBytes(bytes: number): string {
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

function formatContext(tokens: number): string {
	return `${Math.round(tokens / 1024)}k`;
}
