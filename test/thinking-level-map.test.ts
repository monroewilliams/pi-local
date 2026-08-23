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
			off: "none",
		});
	});

	it("maps all levels for a full-vocabulary server", () => {
		expect(
			buildThinkingLevelMap(["minimal", "low", "medium", "high", "xhigh"]),
		).toEqual({
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			off: "none",
		});
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
			off: "none",
		});
		expect(m.reasoning).toBe(true);
	});

	it("falls back to qwen-chat-template when options are not advertised", () => {
		const m = toModel(
			{ ...base, reasoning: true },
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(m.compat).toEqual({ thinkingFormat: "qwen-chat-template" });
		expect(m.thinkingLevelMap).toBeUndefined();
	});

	it("forces reasoning on when a map is built (generic branch requires it)", () => {
		const m = toModel(
			{ ...base, reasoningEffortOptions: ["low"] },
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(m.reasoning).toBe(true);
		expect(m.thinkingLevelMap?.low).toBe("low");
	});

	it("falls back to the boolean toggle when advertised options don't overlap pi levels", () => {
		const m = toModel(
			{ ...base, reasoning: true, reasoningEffortOptions: ["fast", "slow"] },
			"http://127.0.0.1:8000",
			"omlx",
		);
		expect(m.compat).toEqual({ thinkingFormat: "qwen-chat-template" });
		expect(m.thinkingLevelMap).toBeUndefined();
	});

	it("ignores options for non-omlx servers", () => {
		const m = toModel(
			{ ...base, reasoning: true, reasoningEffortOptions: ["low"] },
			"http://127.0.0.1:1234",
			"lmstudio",
		);
		expect(m.compat).toBeUndefined();
		expect(m.thinkingLevelMap).toBeUndefined();
	});
});

describe("adaptModelForRequest", () => {
	const base: DiscoveredModel = {
		id: "test-model",
		displayName: "Test Model",
		description: "",
		loaded: false,
	};
	const fallback = toModel(
		{ ...base, reasoning: true },
		"http://127.0.0.1:8000",
		"omlx",
	);

	it("keeps qwen-chat-template for off and no level", () => {
		for (const level of [undefined, "off"]) {
			const m = adaptModelForRequest(fallback, level);
			expect(m).toBe(fallback);
		}
	});

	it("switches to OpenAI-generic reasoning_effort for on-levels", () => {
		for (const level of ["minimal", "low", "medium", "high"] as const) {
			const m = adaptModelForRequest(fallback, level);
			expect(m.compat).toEqual({ supportsReasoningEffort: true });
			expect(m.thinkingLevelMap?.[level]).toBe(level);
			// Untouched fields survive the shallow copy
			expect(m.id).toBe(fallback.id);
			expect(m.baseUrl).toBe(fallback.baseUrl);
		}
	});

	it("passes through unlisted levels (xhigh/max) via the generic branch", () => {
		const m = adaptModelForRequest(fallback, "xhigh");
		expect(m.compat).toEqual({ supportsReasoningEffort: true });
		expect(m.thinkingLevelMap?.xhigh).toBeUndefined();
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
