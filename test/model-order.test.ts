import { describe, expect, it } from "vitest";
import {
	type DiscoveredModel,
	sortModelsForDisplay,
} from "../src/model-picker.ts";

/** The smallest thing that satisfies `DiscoveredModel`. */
function model(
	id: string,
	overrides: Partial<DiscoveredModel> = {},
): DiscoveredModel {
	return {
		id,
		displayName: id,
		description: "",
		loaded: false,
		...overrides,
	};
}

const names = (models: DiscoveredModel[]) => models.map((m) => m.displayName);

describe("sortModelsForDisplay", () => {
	it("lifts marked models above everything else, each block by display name", () => {
		const models = [
			model("zebra", { displayName: "Zebra" }),
			model("beta-fav", { displayName: "Beta", favorite: true }),
			model("alpha", { displayName: "Alpha" }),
			model("gamma-fav", { displayName: "Gamma", favorite: true }),
		];

		expect(names(sortModelsForDisplay(models))).toEqual([
			"Beta",
			"Gamma",
			"Alpha",
			"Zebra",
		]);
	});

	it("compares display names case-insensitively", () => {
		const models = [
			model("qwen", { displayName: "qwen3.8-flash" }),
			model("llama", { displayName: "LLaMA-3" }),
			model("glm", { displayName: "GLM-4" }),
		];

		expect(names(sortModelsForDisplay(models))).toEqual([
			"GLM-4",
			"LLaMA-3",
			"qwen3.8-flash",
		]);
	});

	it("leaves a list with nothing marked in plain name order", () => {
		const models = [
			model("c", { displayName: "c" }),
			model("a", { displayName: "a" }),
			model("b", { displayName: "b" }),
		];

		expect(names(sortModelsForDisplay(models))).toEqual(["a", "b", "c"]);
	});

	it("puts pinned models in the top block with the favorited ones", () => {
		const models = [
			model("plain", { displayName: "plain" }),
			model("pinned", { displayName: "pinned", pinned: true }),
			model("favourited", { displayName: "favourited", favorite: true }),
			model("both", { displayName: "both", pinned: true, favorite: true }),
		];

		expect(names(sortModelsForDisplay(models))).toEqual([
			"both",
			"favourited",
			"pinned",
			"plain",
		]);
	});

	it("ignores load state", () => {
		// Load state flips while the picker is open, so it cannot rank.
		const models = [
			model("m1", { displayName: "loaded", loaded: true }),
			model("m2", { displayName: "resident", pinned: true }),
			model("m3", { displayName: "idle" }),
		];

		expect(names(sortModelsForDisplay(models))).toEqual([
			"resident",
			"idle",
			"loaded",
		]);
	});

	it("treats a missing flag as not marked", () => {
		const models = [
			model("unset", { displayName: "a", favorite: undefined }),
			model("false", { displayName: "b", favorite: false }),
			model("true", { displayName: "c", favorite: true }),
			model("pin-unset", { displayName: "d", pinned: undefined }),
			model("pin-true", { displayName: "e", pinned: true }),
		];

		expect(names(sortModelsForDisplay(models))).toEqual([
			"c",
			"e",
			"a",
			"b",
			"d",
		]);
	});
});
