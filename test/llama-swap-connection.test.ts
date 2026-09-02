import { afterEach, describe, expect, it, vi } from "vitest";
import {
	loadModel,
	type OpenAIModelEntry,
	queryConnection,
	supportsLoadUnload,
	unloadModel,
} from "../src/model-picker.ts";

const BASE = "http://127.0.0.1:58820";

/** A card as llama-swap serves it, trimmed to what the tests read. */
const SWAP_CARD: OpenAIModelEntry = {
	id: "qwen3-32b-Q4_K_M",
	object: "model",
	owned_by: "llama-swap",
	name: "Qwen3 32B",
	meta: { n_ctx: 131072 },
	status: { value: "unloaded" },
};

/**
 * Stub `fetch` so only llama-swap's own routes answer, and record every URL
 * and method that was asked for.
 */
function stubFetch(
	routes: Record<string, { status?: number; body?: string; json?: unknown }>,
) {
	const calls: { url: string; method: string }[] = [];
	const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, method: init?.method ?? "GET" });
		const key = `${init?.method ?? "GET"} ${decodeURIComponent(new URL(url).pathname)}`;
		const hit = routes[key];
		// A matched route succeeds unless it says otherwise; an unmatched one is
		// a 404, which is how the oMLX and LM Studio probes fall through.
		const status = hit ? (hit.status ?? 200) : 404;
		const body =
			hit?.json !== undefined
				? JSON.stringify(hit.json)
				: (hit?.body ?? "not found");
		return new Response(body, {
			status,
			headers: {
				"Content-Type":
					hit?.json !== undefined ? "application/json" : "text/plain",
			},
		});
	});
	vi.stubGlobal("fetch", fn);
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("llama-swap detection", () => {
	it("recognises llama-swap from owned_by on the listing it already fetched", async () => {
		stubFetch({
			"GET /v1/models": { json: { object: "list", data: [SWAP_CARD] } },
		});

		const result = await queryConnection(BASE, "key");
		expect(result.apiType).toBe("llamaswap");
		expect(result.models[0].contextWindow).toBe(131072);
	});

	it("leaves other OpenAI servers in the generic tier", async () => {
		stubFetch({
			"GET /v1/models": {
				json: {
					object: "list",
					data: [{ id: "m", object: "model", owned_by: "vllm" }],
				},
			},
		});

		const result = await queryConnection(BASE, "key");
		expect(result.apiType).toBe("openai");
	});

	it("stays generic when the listing is empty", async () => {
		stubFetch({
			"GET /v1/models": {
				json: { object: "list", data: [] },
			},
		});

		const result = await queryConnection(BASE, "key");
		expect(result.apiType).toBe("openai");
		expect(result.models).toHaveLength(0);
	});
});

describe("supportsLoadUnload", () => {
	it("offers controls on the three servers that expose them, not on generic OpenAI", () => {
		expect(supportsLoadUnload("omlx")).toBe(true);
		expect(supportsLoadUnload("lmstudio")).toBe(true);
		expect(supportsLoadUnload("llamaswap")).toBe(true);
		expect(supportsLoadUnload("openai")).toBe(false);
	});
});

describe("loadModel on llama-swap", () => {
	it("dispatches /props?model= rather than a completion endpoint", async () => {
		const calls = stubFetch({
			"GET /props": { json: { model_type: "llm" } },
		});

		const res = await loadModel(BASE, "key", "qwen3-32b-Q4_K_M", "llamaswap");
		expect(res).toEqual({ ok: true });
		expect(calls).toEqual([
			{ url: `${BASE}/props?model=qwen3-32b-Q4_K_M`, method: "GET" },
		]);
	});

	it("encodes model ids, which may contain spaces in aliases", async () => {
		const calls = stubFetch({ "GET /props": { json: {} } });

		await loadModel(BASE, "key", "qwen alias", "llamaswap");
		expect(calls[0].url).toBe(`${BASE}/props?model=qwen%20alias`);
	});

	it("treats an upstream 404 as success: the model is loaded by then", async () => {
		// /props is a llama.cpp route. vLLM and others answer 404, but
		// llama-swap has already started and health-checked the process by the
		// time that 404 comes back, so the load happened.
		stubFetch({
			"GET /props": { status: 404, body: '{"error":"not found"}' },
		});

		const res = await loadModel(BASE, "key", "no-caps-model", "llamaswap");
		expect(res).toEqual({ ok: true });
	});

	it("reports llama-swap's own rejection as the error it is", async () => {
		stubFetch({
			"GET /props": {
				status: 404,
				json: {
					src: "llama-swap",
					error: {
						message: "no router for requested model",
						type: "invalid_request_error",
					},
				},
			},
		});

		const res = await loadModel(BASE, "key", "does-not-exist", "llamaswap");
		expect(res).toEqual({ error: "no router for requested model" });
	});

	it("still refuses on the generic tier", async () => {
		stubFetch({});
		const res = await loadModel(BASE, "key", "m", "openai");
		expect(res).toEqual({ error: "load not supported" });
	});
});

describe("unloadModel on llama-swap", () => {
	it("accepts the plain-text OK it answers with", async () => {
		const calls = stubFetch({
			"POST /api/models/unload/qwen3-32b-Q4_K_M": { body: "OK" },
		});

		const res = await unloadModel(BASE, "key", "qwen3-32b-Q4_K_M", "llamaswap");
		expect(res).toEqual({ ok: true });
		expect(calls[0]).toEqual({
			url: `${BASE}/api/models/unload/qwen3-32b-Q4_K_M`,
			method: "POST",
		});
	});

	it("encodes the id in the path", async () => {
		const calls = stubFetch({
			"POST /api/models/unload/qwen alias": { body: "OK" },
		});

		await unloadModel(BASE, "key", "qwen alias", "llamaswap");
		expect(calls[0].url).toBe(`${BASE}/api/models/unload/qwen%20alias`);
	});

	it("reports a selector, which is not a process, as not found", async () => {
		stubFetch({
			"POST /api/models/unload/fast-selector": {
				status: 404,
				json: {
					src: "llama-swap",
					error: { message: "model not found" },
				},
			},
		});

		const res = await unloadModel(BASE, "key", "fast-selector", "llamaswap");
		expect(res).toEqual({ error: "model not found" });
	});
});
