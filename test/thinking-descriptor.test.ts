import { describe, expect, it } from "vitest";
import { describeThinking } from "../src/thinking.ts";

describe("describeThinking", () => {
	it("reads an effort vocabulary", () => {
		const d = describeThinking({
			thinking_default: null,
			preserve_thinking_default: true,
			reasoning_effort_options: ["low", "high", "max"],
		});
		expect(d.advertisesEffort).toBe(true);
		expect(d.effortOptions).toEqual(["low", "high", "max"]);
	});

	it("records the toggle default without naming any levels", () => {
		const d = describeThinking({ thinking_default: false });
		expect(d.thinkingDefault).toBe(false);
		expect(d.effortOptions).toEqual([]);
	});

	it("records a preserve knob, which is a history control", () => {
		// GLM-5.3's template reads clear_thinking, so it emits thinking blocks
		// while having no enable_thinking for us to set.
		const d = describeThinking({
			thinking_default: null,
			preserve_thinking_default: false,
		});
		expect(d.preserveThinkingDefault).toBe(false);
		expect(d.thinkingDefault).toBeUndefined();
	});

	it("reports nothing for an empty entry", () => {
		const d = describeThinking({});
		expect(d.advertisesEffort).toBe(false);
		expect(d.thinkingDefault).toBeUndefined();
		expect(d.effortOptions).toEqual([]);
	});

	it("rejects a malformed list rather than half-trusting it", () => {
		const d = describeThinking({
			reasoning_effort_options: ["low", 3, null],
		} as unknown as Parameters<typeof describeThinking>[0]);
		expect(d.advertisesEffort).toBe(true);
		expect(d.effortOptions).toEqual([]);
	});

	it("distinguishes an absent effort key from a null one", () => {
		// Absent means oMLX from before the discovery PR, which forwards
		// reasoning_effort:"none" straight to the template; the PR's merge turns
		// it into enable_thinking:false first, so only the latter can be sent.
		expect(describeThinking({}).advertisesEffort).toBe(false);
		expect(
			describeThinking({ reasoning_effort_options: null }).advertisesEffort,
		).toBe(true);
	});
});
