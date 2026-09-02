// ============================================================================
// Thinking controls, derived from a server's model-status entry.
//
// oMLX reports *facts* about the chat template; the vocabulary, the ordering
// and the wire format are ours to choose. Three knobs show up in the status
// entry, each on its own axis:
//
//   thinking_default            the template reads `enable_thinking` (Qwen,
//                               Gemma, Nemotron, LongCat, Ornith, ThinkingCap…)
//   preserve_thinking_default   the template reads `preserve_thinking` or
//                               `clear_thinking` (GLM-family) — a *history* knob,
//                               and evidence that the model emits thinking blocks
//   reasoning_effort_options    the template consumes a named vocabulary
//                               (gpt-oss, GLM, ThinkingCap, Inkling)
//
// `reasoning_effort_options` is the field that settles the ladder: when the
// server names the levels we confine the selector to them, and when it offers
// no set the whole ladder stays selectable. Nothing here claims a model can or
// cannot think — Nemotron-3.5-Lightning answers to the toggle while naming no
// levels, so a capability badge would be a guess in both directions. The set of
// levels is the useful output; whether a model thinks is for the user to
// observe.
// ============================================================================

/** The subset of a status entry this module reads. */
export interface ThinkingFields {
	thinking_default?: boolean | null;
	preserve_thinking_default?: boolean | null;
	reasoning_effort_options?: string[] | null;
}

export interface ThinkingDescriptor {
	/** Template default for `enable_thinking`; set when the template has that knob. */
	thinkingDefault?: boolean;
	/** Template strips historical thinking blocks unless asked to keep them. */
	preserveThinkingDefault?: boolean;
	/** Effort levels the template accepts, in the server's own spellings. */
	effortOptions: string[];
	/**
	 * `reasoning_effort_options` was a key in the response, so this is oMLX from
	 * the discovery PR onwards. That release is also what turns
	 * `reasoning_effort: "none"` into `enable_thinking: False` before the
	 * template runs (api/utils.py), so `"none"` is safe to send exactly here.
	 * Earlier servers forward `"none"` verbatim, and a strict-vocabulary template
	 * like Qwen 3.8's `xhigh/medium/low` whitelist answers with an exception.
	 */
	advertisesEffort: boolean;
}

function boolOrNull(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string")
		? [...value]
		: [];
}

/**
 * Turn a status entry into a descriptor. Accepts any shape the server sends —
 * fields may be absent, null or malformed — and an older server contributes
 * just the signals it happens to carry.
 */
export function describeThinking(entry: ThinkingFields): ThinkingDescriptor {
	const thinkingDefault = boolOrNull(entry.thinking_default);
	const preserveThinkingDefault = boolOrNull(entry.preserve_thinking_default);
	const advertisesEffort = Object.hasOwn(entry, "reasoning_effort_options");
	const effortOptions = advertisesEffort
		? stringList(entry.reasoning_effort_options)
		: [];

	return {
		thinkingDefault,
		preserveThinkingDefault,
		effortOptions,
		advertisesEffort,
	};
}
