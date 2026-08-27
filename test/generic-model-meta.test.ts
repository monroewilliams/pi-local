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
});
