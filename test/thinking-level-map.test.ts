import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { DiscoveredModel } from "../src/model-picker.ts";
import {
	adaptModelForRequest,
	buildThinkingLevelMap,
	toModel,
} from "../src/provider.ts";

describe("buildThinkingLevelMap", () => {
	it("maps advertised levels to themselves and hides the rest (Qwen3.8)", () => {
		expect(buildThinkingLevelMap(["xhigh", "medium", "low"])).toEqual({
			minimal: null,
			low: "low",
			medium: "medium",
			high: null,
			xhigh: "xhigh",
			max: null,
			off: "none",
		});
	});

	it("maps all levels for a full-vocabulary server", () => {
		expect(
			buildThinkingLevelMap([
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]),
		).toEqual({
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
			off: "none",
		});
	});

	it("leaves max hidden unless the server advertises it", () => {
		expect(
			buildThinkingLevelMap(["minimal", "low", "medium", "high", "xhigh"]),
		).toMatchObject({ max: null });
	});

	it("returns undefined when the vocabulary doesn't overlap pi levels", () => {
		expect(buildThinkingLevelMap(["fast", "slow"])).toBeUndefined();
	});
});

describe("toModel (omlx)", () => {
	const base: DiscoveredModel = {
		id: "test-model",
		displayName: "Test Model",
		description: "",
		loaded: false,
	};

	it("uses the reasoning_effort map when the server advertises options", () => {
		const m = toModel(
			{
				...base,
				reasoning: true,
				reasoningEffortOptions: ["xhigh", "medium", "low"],
			},
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(m.compat).toEqual({ supportsReasoningEffort: true });
		expect(m.thinkingLevelMap).toEqual({
			minimal: null,
			low: "low",
			medium: "medium",
			high: null,
			xhigh: "xhigh",
			max: null,
			off: "none",
		});
		expect(m.reasoning).toBe(true);
	});

	it("drives enable_thinking through chat-template when the template has it", () => {
		const m = toModel(
			{ ...base, reasoning: true, thinkingDefault: false },
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(m.compat).toEqual({
			thinkingFormat: "chat-template",
			chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
		});
		// The ladder stays selectable; every level above off arrives at this
		// template as the same enable_thinking: true.
		expect(m.thinkingLevelMap?.max).toBe("max");
	});

	it("carries a discovered preserve_thinking_default through chat-template", () => {
		// qwen-chat-template would force preserve_thinking:true; a template that
		// clears history by default has to say so on the wire.
		const m = toModel(
			{
				...base,
				reasoning: true,
				thinkingDefault: true,
				preserveThinkingDefault: false,
			},
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(m.compat).toEqual({
			thinkingFormat: "chat-template",
			chatTemplateKwargs: {
				enable_thinking: { $var: "thinking.enabled" },
				preserve_thinking: false,
			},
		});
	});

	it("gives a reasoning model with neither knob the whole ladder", () => {
		// gpt-oss advertises ["medium"] — one level is no menu — and GLM before
		// the discovery PR has no enable_thinking. Effort is the channel left, and
		// a template with no whitelist takes any level the user picks.
		const m = toModel(
			{ ...base, reasoning: true },
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(m.reasoning).toBe(true);
		expect(m.compat).toEqual({ supportsReasoningEffort: true });
		expect(m.thinkingLevelMap).toEqual({
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	it("keeps max selectable, since pi documents it and GLM defaults to it", () => {
		const m = toModel(
			{
				...base,
				reasoning: true,
				reasoningEffortOptions: ["low", "high", "max"],
			},
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(m.thinkingLevelMap?.max).toBe("max");
	});

	it("treats a single advertised level as no menu, falling back to the ladder", () => {
		const m = toModel(
			{ ...base, reasoning: true, reasoningEffortOptions: ["medium"] },
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(m.compat).toEqual({ supportsReasoningEffort: true });
		expect(m.thinkingLevelMap).toEqual({
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	it("orders the menu by pi's ladder, not by the server's enumeration", () => {
		const m = toModel(
			{
				...base,
				reasoning: true,
				reasoningEffortOptions: ["max", "low", "high"],
			},
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(
			Object.keys(m.thinkingLevelMap ?? {}).filter(
				(k) => (m.thinkingLevelMap as Record<string, string | null>)[k] != null,
			),
		).toEqual(["low", "high", "max", "off"]);
	});

	it("drives effort by the vocabulary even when enable_thinking also exists", () => {
		// A template that consumes reasoning_effort is not inert to it, and pi's
		// qwen-chat-template branch emits no reasoning_effort at all, so the
		// menu wins whenever both knobs are present.
		const m = toModel(
			{
				...base,
				reasoning: true,
				thinkingDefault: true,
				reasoningEffortOptions: ["low", "high"],
			},
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(m.compat).toEqual({ supportsReasoningEffort: true });
	});

	it("forces reasoning on when a map is built (generic branch requires it)", () => {
		const m = toModel(
			{ ...base, reasoningEffortOptions: ["low", "high"] },
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(m.reasoning).toBe(true);
		expect(m.thinkingLevelMap?.low).toBe("low");
	});

	it("falls back to the toggle when advertised options don't overlap pi levels", () => {
		const m = toModel(
			{
				...base,
				reasoning: true,
				thinkingDefault: true,
				reasoningEffortOptions: ["fast", "slow"],
			},
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(m.compat).toEqual({
			thinkingFormat: "chat-template",
			chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
		});
		expect(m.thinkingLevelMap?.max).toBe("max");
	});

	it("gives lmstudio the whole ladder instead of its on/off vocabulary", () => {
		// LM Studio's allowed_options answered ["off", "on"] for the only model
		// that populates it, so the full map is the more informative answer.
		const m = toModel(
			{ ...base, reasoning: true, reasoningEffortOptions: ["low"] },
			"http://127.0.0.1:1234",
			"lmstudio",
		);
		expect(m.compat).toEqual({ supportsReasoningEffort: true });
		expect(m.thinkingLevelMap).toEqual({
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});
});

describe("toModel (unknown engine / OpenAI-generic)", () => {
	const base: DiscoveredModel = {
		id: "test-model",
		displayName: "Test Model",
		description: "",
		loaded: false,
	};

	const GENERIC_MAP = {
		off: "none",
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	};

	it("offers the whole ladder including max", () => {
		const m = toModel(base, "http://127.0.0.1:8000", "openai");
		expect(m.reasoning).toBe(true);
		expect(m.compat).toEqual({ supportsReasoningEffort: true });
		expect(m.thinkingLevelMap).toEqual(GENERIC_MAP);
	});

	it("offers the whole ladder including max, with off", () => {
		const m = toModel(base, "http://127.0.0.1:8000", "openai");
		expect(getSupportedThinkingLevels(m)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		// Without the map, pi caps a reasoning model at "high".
		expect(
			getSupportedThinkingLevels({ ...m, thinkingLevelMap: undefined }),
		).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	it("maps off to the value llama.cpp uses to disable thinking", () => {
		const m = toModel(base, "http://127.0.0.1:8000", "openai");
		expect(m.thinkingLevelMap?.off).toBe("none");
	});

	it("treats an unknown cached apiType as generic", () => {
		const m = toModel(base, "http://127.0.0.1:8000");
		expect(m.thinkingLevelMap).toEqual(GENERIC_MAP);
	});

	it("gives each model its own map", () => {
		const a = toModel(base, "http://127.0.0.1:8000", "openai");
		const b = toModel(base, "http://127.0.0.1:8080", "openai");
		const aMap = a.thinkingLevelMap;
		const bMap = b.thinkingLevelMap;
		expect(aMap).not.toBe(bMap);
		if (aMap && bMap) {
			aMap.high = "mutated";
			expect(bMap.high).toBe("high");
		}
	});

	it("is left alone by adaptModelForRequest (nothing to swap)", () => {
		const m = toModel(base, "http://127.0.0.1:8000", "openai");
		for (const level of [undefined, "off", "xhigh"] as const) {
			expect(adaptModelForRequest(m, level)).toBe(m);
		}
	});
});

describe("adaptModelForRequest", () => {
	const base: DiscoveredModel = {
		id: "test-model",
		displayName: "Test Model",
		description: "",
		loaded: false,
	};
	// A toggle-only model: the template reads enable_thinking and advertises no
	// effort vocabulary.
	const fallback = toModel(
		{ ...base, reasoning: true, thinkingDefault: true },
		"http://127.0.0.1:8000",
		"omlx",
	);

	it("keeps the toggle format at every level, on-levels included", () => {
		// A level reaches these templates through enable_thinking, so the format
		// has to survive the whole ladder. oMLX turns effort into
		// enable_thinking:false for "none" and forwards it alone otherwise, so a
		// level sent as bare effort leaves thinking at the template's own default.
		for (const level of [
			undefined,
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		] as const) {
			const m = adaptModelForRequest(fallback, level);
			expect(m).toBe(fallback);
			expect(m.compat?.thinkingFormat).toBe("chat-template");
			expect(m.compat?.chatTemplateKwargs?.enable_thinking).toEqual({
				$var: "thinking.enabled",
			});
		}
	});

	it("leaves models with a discovered thinkingLevelMap untouched", () => {
		const mapped = toModel(
			{ ...base, reasoning: true, reasoningEffortOptions: ["low", "high"] },
			"http://127.0.0.1:8000",
			"omlx",
		);
		for (const level of [undefined, "off", "low"]) {
			expect(adaptModelForRequest(mapped, level)).toBe(mapped);
		}
	});

	it("leaves non-fallback models untouched", () => {
		const plain = toModel(base, "http://127.0.0.1:1234", "lmstudio");
		expect(adaptModelForRequest(plain, "low")).toBe(plain);

		const nonReasoning = toModel(
			{ ...base, reasoning: false },
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(adaptModelForRequest(nonReasoning, "low")).toBe(nonReasoning);
	});
});
