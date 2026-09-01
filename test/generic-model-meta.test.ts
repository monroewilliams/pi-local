import { describe, expect, it } from "vitest";
import { mapOpenAiModels, type OpenAIModelEntry } from "../src/model-picker.ts";
import { toModel } from "../src/provider.ts";

/** A llama.cpp `/v1/models` response body, trimmed to what matters. */
const LLAMA_CPP_ENTRY = {
	id: "Qwen3.8-Flash-Next-AD-4.27bpw-Q4_K_M-M64",
	object: "model",
	meta: {
		vocab_type: 1,
		n_vocab: 248320,
		n_ctx: 262144,
		n_ctx_train: 262144,
		n_embd: 2560,
		n_params: 176943899520,
		size: 94514368000,
		ftype: "IQ2_S - 2.5 bpw",
	},
};

describe("mapOpenAiModels", () => {
	it("reads llama.cpp n_ctx and size into the right-hand column", () => {
		const [m] = mapOpenAiModels([LLAMA_CPP_ENTRY]);
		expect(m.contextWindow).toBe(262144);
		expect(m.sizeBytes).toBe(94514368000);
		expect(m.description).toBe("|  88.0G, ctx: 256k");
	});

	it("formats size and context the way the oMLX backend does", () => {
		// oMLX: `|${(bytes / 1024**3).toFixed(1).padStart(6)}G` and
		// `ctx:${Math.round(tokens / 1024).toString().padStart(4)}k`
		const [m] = mapOpenAiModels([
			{ id: "m", meta: { n_ctx: 4096, size: 5 * 1024 * 1024 * 1024 } },
		]);
		expect(m.description).toBe("|   5.0G, ctx:   4k");
	});

	it("leaves the column blank when the server advertises nothing", () => {
		const [m] = mapOpenAiModels([{ id: "gpt-oss" }]);
		expect(m.contextWindow).toBeUndefined();
		expect(m.sizeBytes).toBeUndefined();
		expect(m.description).toBe("");
	});

	it("keeps the parts it has when only one is available", () => {
		const [ctxOnly] = mapOpenAiModels([{ id: "m", meta: { n_ctx: 32768 } }]);
		expect(ctxOnly.description).toBe("ctx:  32k");

		const [sizeOnly] = mapOpenAiModels([
			{ id: "m", meta: { size: 40 * 1024 * 1024 * 1024 } },
		]);
		expect(sizeOnly.description).toBe("|  40.0G");
	});

	it("treats non-numeric or non-positive values as absent", () => {
		// llama.cpp's sibling `models` array uses size: "" for the same field.
		const [asString, notPositive] = mapOpenAiModels([
			{ id: "m", meta: { n_ctx: "262144", size: "" } },
			{ id: "z", meta: { n_ctx: 0, size: -1 } },
		] as unknown as OpenAIModelEntry[]);
		for (const m of [asString, notPositive]) {
			expect(m.contextWindow).toBeUndefined();
			expect(m.sizeBytes).toBeUndefined();
			expect(m.description).toBe("");
		}
	});

	it("skips malformed entries but keeps the rest", () => {
		const models = mapOpenAiModels([
			null,
			{ object: "model" },
			{ id: "ok", meta: { n_ctx: 8192 } },
		] as unknown as OpenAIModelEntry[]);
		expect(models.map((m) => m.id)).toEqual(["ok"]);
	});
});

describe("context window from a generic server reaches pi", () => {
	it("uses the advertised n_ctx instead of the default", () => {
		const [m] = mapOpenAiModels([LLAMA_CPP_ENTRY]);
		const model = toModel(m, "http://127.0.0.1:8001", "openai");
		expect(model.contextWindow).toBe(262144);
	});

	it("falls back to the default when the server says nothing", () => {
		const [m] = mapOpenAiModels([{ id: "gpt-oss" }]);
		const model = toModel(m, "http://127.0.0.1:8001", "openai");
		expect(model.contextWindow).toBe(128000);
	});

	it("uses vLLM's max_model_len instead of the default", () => {
		const [m] = mapOpenAiModels([VLLM_BASE_CARD]);
		const model = toModel(m, "http://127.0.0.1:8000", "openai");
		expect(model.contextWindow).toBe(40960);
	});
});

describe("mapOpenAiModels on a vLLM response", () => {
	it("reads the context window off the flat card", () => {
		const [m] = mapOpenAiModels([VLLM_BASE_CARD]);
		expect(m.contextWindow).toBe(40960);
		// vLLM reports no size, so only the context half of the column fills.
		expect(m.description).toBe("ctx:  40k");
	});

	it("treats the null vLLM always sends as absent", () => {
		const [m] = mapOpenAiModels([VLLM_ADAPTER_CARD]);
		expect(m.contextWindow).toBeUndefined();
		expect(m.description).toBe("");
	});

	it("gives a LoRA adapter its base model's context window", () => {
		// An adapter is a selectable model: requests name it in `model` and run
		// against the base's weights, so the base's context is its real budget.
		const [base, adapter] = mapOpenAiModels([
			VLLM_BASE_CARD,
			VLLM_ADAPTER_CARD,
		]);
		expect(base.contextWindow).toBe(40960);
		expect(adapter.contextWindow).toBe(40960);
		expect(adapter.description).toBe("ctx:  40k");
	});

	it("leaves an adapter blank when its base model isn't in the response", () => {
		const [adapter] = mapOpenAiModels([
			{ ...VLLM_ADAPTER_CARD, parent: "some-other-base" },
		]);
		expect(adapter.contextWindow).toBeUndefined();
	});

	it("prefers llama.cpp's meta when a server somehow reports both", () => {
		// No llama.cpp build emits max_model_len; this only pins the precedence
		// so a llama.cpp context window can never be shadowed by the new field.
		const [m] = mapOpenAiModels([
			{ ...LLAMA_CPP_ENTRY, max_model_len: null },
			{ ...LLAMA_CPP_ENTRY, max_model_len: 4096 },
		]);
		expect(m.contextWindow).toBe(262144);
		expect(m.description).toBe("|  88.0G, ctx: 256k");
	});
});

describe("mapOpenAiModels on a llama-swap response", () => {
	it("reads the operator's declared context out of meta.n_ctx", () => {
		// llama-swap renders `capabilities.context` into context_length,
		// context_window and meta.n_ctx alike; the existing meta reading already
		// covers it, so this pins that llama-swap needs no new plumbing.
		const [m] = mapOpenAiModels([LLAMASWAP_CARD]);
		expect(m.contextWindow).toBe(131072);
		expect(toModel(m, "http://127.0.0.1:8080", "openai").contextWindow).toBe(
			131072,
		);
	});

	it("falls back to its default when the operator declared no context", () => {
		// `capabilities.context` defaults to 0, and llama-swap omits the key
		// entirely rather than sending 0.
		const [m] = mapOpenAiModels([LLAMASWAP_BARE]);
		expect(m.contextWindow).toBeUndefined();
		expect(toModel(m, "http://127.0.0.1:8080", "openai").contextWindow).toBe(
			128000,
		);
	});

	it("uses the operator's name as the display name", () => {
		const [m] = mapOpenAiModels([LLAMASWAP_CARD]);
		expect(m.displayName).toBe("Qwen3 32B");
		expect(toModel(m, "http://127.0.0.1:8080", "openai").name).toBe(
			"Qwen3 32B",
		);
	});

	it("keeps the id when the name is unset or blank", () => {
		const [unset, blank] = mapOpenAiModels([
			LLAMASWAP_BARE,
			{ ...LLAMASWAP_CARD, name: "   " },
		]);
		expect(unset.displayName).toBe("qwen3-32b-Q4_K_M");
		expect(blank.displayName).toBe("qwen3-32b-Q4_K_M");
	});

	it("carries live load state, which the other backends' cards leave false", () => {
		const [loaded, unloaded] = mapOpenAiModels([
			{ ...LLAMASWAP_CARD, status: { value: "loaded" } },
			LLAMASWAP_CARD,
		]);
		expect(loaded.loaded).toBe(true);
		expect(unloaded.loaded).toBe(false);
		// A card from a server that sends no status at all is not "unloaded by
		// measurement", it is silent — same value, different reason.
		expect(mapOpenAiModels([LLAMA_CPP_ENTRY])[0].loaded).toBe(false);
	});

	it("registers a vision model for image input", () => {
		const [m] = mapOpenAiModels([LLAMASWAP_CARD]);
		expect(m.vision).toBe(true);
		expect(m.modelType).toBe("vlm");
		expect(toModel(m, "http://127.0.0.1:8080", "openai").input).toEqual([
			"text",
			"image",
		]);
	});

	it("reads vision from the modality lists when capabilities is absent", () => {
		// capabilities.vision is only ever emitted when true, so an absent key
		// is not evidence of text-only; the modality lists are.
		const [vision] = mapOpenAiModels([
			{
				id: "vlm",
				architecture: { input_modalities: ["text", "image"] },
			},
		]);
		expect(vision.vision).toBe(true);
		expect(toModel(vision, "http://127.0.0.1:8080", "openai").input).toEqual([
			"text",
			"image",
		]);

		const [text] = mapOpenAiModels([
			{ id: "llm", architecture: { input_modalities: ["text"] } },
		]);
		expect(text.vision).toBe(false);
		expect(text.modelType).toBe("llm");
		expect(toModel(text, "http://127.0.0.1:8080", "openai").input).toEqual([
			"text",
		]);
	});

	it("leaves modality unknown when the server says nothing about it", () => {
		const [m] = mapOpenAiModels([LLAMASWAP_BARE]);
		expect(m.vision).toBeUndefined();
		expect(m.modelType).toBeUndefined();
		expect(m.description).toBe("");
		expect(toModel(m, "http://127.0.0.1:8080", "openai").input).toEqual([
			"text",
		]);
	});

	it("appends the type to the column without disturbing the widths", () => {
		const [vision] = mapOpenAiModels([LLAMASWAP_CARD]);
		// llama-swap reports no model file size, so the size half stays blank.
		expect(vision.description).toBe("ctx: 128k, vlm");
	});
});

/** A vLLM `/v1/models` entry, fields and all. `permission` and `owned_by` are
 *  not read here, just present as they are in a live response. */
const VLLM_BASE_CARD = {
	id: "Qwen/Qwen3-0.6B",
	object: "model",
	created: 1715644056,
	owned_by: "vllm",
	root: "Qwen/Qwen3-0.6B",
	parent: null,
	max_model_len: 40960,
	permission: [{ id: "modelperm-abc", object: "model_permission" }],
} as OpenAIModelEntry;

/** The LoRA adapter vLLM lists alongside it, which reports no context itself. */
const VLLM_ADAPTER_CARD = {
	id: "sql-lora",
	object: "model",
	created: 1715644056,
	owned_by: "vllm",
	root: "jeeejeee/llama32-3b-text2sql-spider",
	parent: "Qwen/Qwen3-0.6B",
	max_model_len: null,
	permission: [{ id: "modelperm-def", object: "model_permission" }],
} as OpenAIModelEntry;

/**
 * A llama-swap `/v1/models` card, captured from a live llama-swap v252 rather
 * than written by hand — every field here is what the server actually sent for
 * a config setting `name`, `capabilities.in: [text, image]`, `tools: true` and
 * `context: 131072`. The shape is llama-swap's `modelRecord`
 * (`internal/server/api.go`), stable across releases.
 */
const LLAMASWAP_CARD = {
	id: "qwen3-32b-Q4_K_M",
	object: "model",
	created: 1788303342,
	owned_by: "llama-swap",
	name: "Qwen3 32B",
	description: "general purpose",
	architecture: {
		input_modalities: ["text", "image"],
		output_modalities: ["text"],
		modality: "text+image->text",
	},
	capabilities: { function_calling: true, vision: true },
	supported_parameters: ["tools", "tool_choice"],
	context_length: 131072,
	context_window: 131072,
	meta: {
		n_ctx: 131072,
		llamaswap: { type: "model", aliases: ["qwen alias"], note: "ctx=131072" },
	},
	status: { value: "unloaded" },
} as OpenAIModelEntry;

/** The same server with a bare config: no name, no capabilities, no context. */
const LLAMASWAP_BARE = {
	id: "qwen3-32b-Q4_K_M",
	object: "model",
	created: 1788303342,
	owned_by: "llama-swap",
	meta: { llamaswap: { type: "model" } },
	status: { value: "unloaded" },
} as OpenAIModelEntry;
