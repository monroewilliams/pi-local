import { describe, expect, it } from "vitest";
import type { DiscoveredModel, QueryResult } from "../src/model-picker.ts";
import { formatStatus } from "../src/ui.ts";

function model(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
	return {
		id: "m",
		displayName: "M",
		description: "",
		loaded: false,
		...overrides,
	};
}

const result = (
	apiType: QueryResult["apiType"],
	models: DiscoveredModel[],
): QueryResult => ({ apiType, models });

describe("formatStatus", () => {
	it("counts loaded models on llama-swap off the cards it already has", () => {
		// llama-swap arrives as `llamaswap`, so the count is read from the tier it
		// actually lands in.
		const status = formatStatus(
			result("llamaswap", [
				model({ id: "a", loaded: true }),
				model({ id: "b", loaded: true }),
				model({ id: "c" }),
			]),
		);

		expect(status).toBe("2/3 models loaded");
	});

	it("stays silent on llama-swap until something is loaded", () => {
		// "0/8 loaded" reads as a measurement; silence reads as "nothing running".
		const status = formatStatus(
			result("llamaswap", [model({ id: "a" }), model({ id: "b" })]),
		);

		expect(status).toBeUndefined();
	});

	it("reports every LM Studio model set, including zero loaded", () => {
		expect(formatStatus(result("lmstudio", [model()]))).toBe(
			"0/1 models loaded",
		);
	});

	it("says nothing for a plain OpenAI server, which reports no load state", () => {
		expect(formatStatus(result("openai", [model()]))).toBeUndefined();
	});

	it("summarises oMLX from its /api/status payload", () => {
		const status = formatStatus({
			apiType: "omlx",
			models: [model()],
			status: {
				version: "0.6.4",
				models_loaded: 1,
				models_discovered: 33,
				models_loading: 0,
				model_memory_used_formatted: "36.9GB",
				model_memory_max_formatted: "107.5GB",
			},
		});

		expect(status).toBe(
			"oMLX 0.6.4: 1/33 loaded, 0 loading, using 36.9GB of 107.5GB",
		);
	});
});
