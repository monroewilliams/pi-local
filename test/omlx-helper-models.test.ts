import { afterEach, describe, expect, it, vi } from "vitest";
import { queryConnection } from "../src/model-picker.ts";

const BASE = "http://127.0.0.1:58821";

/** Serve an oMLX `/v1/models/status` body; every other route is a 404. */
function stubOmlxStatus(models: unknown[]) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown) => {
			const path = new URL(String(input)).pathname;
			if (path === "/v1/models/status") {
				return new Response(JSON.stringify({ models }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("oMLX helper models", () => {
	it("leaves out models the server flags as speculative-decoding helpers", async () => {
		stubOmlxStatus([
			{ id: "ornith-ai--Ornith-1.5-35B-A3B-MLX-4bit", model_type: "llm" },
			{
				id: "jzinno--Ornith-1.5-35B-A3B-DFlash2",
				model_type: "llm",
				is_helper: true,
			},
			{
				// A real chat model whose name looks like a helper's; is_helper is
				// false, so it must stay.
				id: "Jundot--Qwen3.8-27B-oQ4e-mtp",
				model_type: "vlm",
				is_helper: false,
			},
		]);

		const result = await queryConnection(BASE, "key");

		expect(result.apiType).toBe("omlx");
		expect(result.models.map((m) => m.id).sort()).toEqual([
			"Jundot--Qwen3.8-27B-oQ4e-mtp",
			"ornith-ai--Ornith-1.5-35B-A3B-MLX-4bit",
		]);
	});
});
