// ============================================================================
// Thinking controls, read from a model-status entry.
//
// Three independent fields, each describing a different knob on the chat
// template:
//
//   thinking_default           template reads `enable_thinking`
//   preserve_thinking_default  template reads `preserve_thinking` /
//                              `clear_thinking` (keeps or drops past thinking
//                              blocks; also evidence the model emits them)
//   reasoning_effort_options   template accepts a named effort vocabulary
//
// `reasoning_effort_options` decides the selector: when the server lists
// levels, offer only those; when it lists none, offer the whole ladder.
// None of these fields states whether a model can think, so nothing here
// renders a capability badge.
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
	 * The response had a `reasoning_effort_options` key. Released oMLX does not
	 * send it; that comes from a pending PR.
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
 * Read a status entry into a descriptor. Fields may be absent, null or the
 * wrong type; anything unrecognized reads as absent.
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
