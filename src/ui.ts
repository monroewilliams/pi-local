import type {
	ExtensionCommandContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	type DiscoveredModel,
	type QueryResult,
	supportsLoadUnload,
} from "./model-picker.ts";

// ============================================================================
// Types
// ============================================================================

export type LocalPickerAction =
	| { type: "select"; model: DiscoveredModel }
	| { type: "load"; model: DiscoveredModel }
	| { type: "unload"; model: DiscoveredModel }
	| { type: "close" };

// ============================================================================
// Helpers
// ============================================================================

function formatStatus(result: QueryResult): string | undefined {
	if (result.apiType === "omlx" && result.status) {
		const s = result.status;
		return `oMLX ${s.version ?? "?"}: ${s.models_loaded ?? 0}/${s.models_discovered ?? "?"} loaded, ${s.models_loading ?? 0} loading, using ${s.model_memory_used_formatted ?? "?"} of ${s.model_memory_max_formatted ?? "?"}`;
	}
	if (result.apiType === "lmstudio") {
		const loaded = result.models.filter((m) => m.loaded).length;
		return `${loaded}/${result.models.length} models loaded`;
	}
	// llama-swap reports per-model `status`, so the count is real here too. It
	// is printed only once something is loaded: a plain OpenAI server sends no
	// load state at all, and "0/N loaded" would read as a measurement rather
	// than as silence.
	if (result.apiType === "openai") {
		const loaded = result.models.filter((m) => m.loaded).length;
		if (loaded > 0) return `${loaded}/${result.models.length} models loaded`;
	}
	return undefined;
}

function formatItem(m: DiscoveredModel): {
	label: string;
	description: string;
} {
	const icon = m.pinned ? "📌" : m.loaded ? "✅" : m.favorite ? "⭐" : "  ";
	return { label: `${icon} ${m.displayName}`, description: m.description };
}

// ============================================================================
// Border component (inline, avoids importing pi internals)
// ============================================================================

class Border implements Component {
	private colorFn: (text: string) => string;

	constructor(colorFn: (text: string) => string) {
		this.colorFn = colorFn;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [this.colorFn("─".repeat(Math.max(1, width)))];
	}
}

// ============================================================================
// LocalPickerView — full-screen model picker with load/unload
// ============================================================================

class LocalPickerView implements Focusable {
	private tui: TUI;
	/**
	 * Narrowed to pi's own color vocabulary so callers hand `theme.fg` a color
	 * it accepts instead of casting one loose through `any`.
	 */
	private fg: (color: ThemeColor, text: string) => string;
	private bold: (text: string) => string;
	private done: (action: LocalPickerAction) => void;
	private content = new Container();
	private list?: SelectList;
	private models: DiscoveredModel[];
	private hasLoadUnload: boolean;
	private _focused = false;

	constructor(
		tui: TUI,
		fg: (color: ThemeColor, text: string) => string,
		bold: (text: string) => string,
		done: (action: LocalPickerAction) => void,
		baseUrl: string,
		result: QueryResult,
		initialSelectedId?: string,
	) {
		this.tui = tui;
		this.fg = fg;
		this.bold = bold;
		this.done = done;
		this.models = result.models;
		this.hasLoadUnload = supportsLoadUnload(result.apiType);
		this.build(baseUrl, result, initialSelectedId);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	private build(
		baseUrl: string,
		result: QueryResult,
		initialSelectedId?: string,
	): void {
		this.models = result.models;
		this.hasLoadUnload = supportsLoadUnload(result.apiType);

		const items: SelectItem[] = this.models.map((m) => {
			const { label, description } = formatItem(m);
			return { value: m.id, label, description };
		});

		const list = new SelectList(
			items,
			Math.min(items.length, 10),
			{
				selectedPrefix: (t: string) => this.fg("accent", t),
				selectedText: (t: string) => this.fg("accent", t),
				description: (t: string) => this.fg("muted", t),
				scrollInfo: (t: string) => this.fg("dim", t),
				noMatch: (t: string) => this.fg("muted", t),
			},
			{ minPrimaryColumnWidth: 36, maxPrimaryColumnWidth: 56 },
		);

		this.list = list;

		// Restore selection position after load/unload
		if (initialSelectedId) {
			const idx = this.models.findIndex((m) => m.id === initialSelectedId);
			if (idx >= 0) this.list.setSelectedIndex(idx);
		}

		// Wire up select / cancel — these go straight to done()
		list.onSelect = (item: SelectItem) => {
			const model = this.models.find((m) => m.id === item.value);
			if (model) this.done({ type: "select", model });
		};
		list.onCancel = () => this.done({ type: "close" });

		// Build frame
		const body: Component[] = [];
		body.push(new Text(this.fg("dim", baseUrl), 1, 0));
		body.push(new Spacer(1));

		const status = formatStatus(result);
		if (status) {
			body.push(new Text(this.fg("muted", status), 1, 0));
			body.push(new Spacer(1));
		}

		body.push(list);

		const kb = getKeybindings();
		const parts: string[] = [
			this.fg("dim", kb.getKeys("tui.select.confirm").join("/")) +
				this.fg("muted", " select"),
		];
		if (this.hasLoadUnload) {
			parts.push(this.fg("dim", "l") + this.fg("muted", " load"));
			parts.push(this.fg("dim", "u") + this.fg("muted", " unload"));
		}
		parts.push(
			this.fg("dim", kb.getKeys("tui.select.cancel").join("/")) +
				this.fg("muted", " close"),
		);

		const container = new Container();
		container.addChild(new Border((t) => this.fg("accent", t)));
		container.addChild(
			new Text(this.fg("accent", this.bold("Local Models")), 1, 0),
		);
		for (const child of body) container.addChild(child);
		container.addChild(new Spacer(1));
		container.addChild(new Text(parts.join(" • "), 1, 0));
		container.addChild(new Border((t) => this.fg("accent", t)));

		this.content = container;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		// Intercept l/u before the list sees them
		if (this.hasLoadUnload && this.list) {
			if (data === "l" || data === "u") {
				const selected = this.list.getSelectedItem();
				if (selected) {
					const model = this.models.find((m) => m.id === selected.value);
					if (model) {
						const action =
							data === "l" ? ("load" as const) : ("unload" as const);
						this.done({ type: action, model });
						return;
					}
				}
			}
		}

		// Pass through to SelectList (arrows, enter, esc, etc.)
		this.list?.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.content
			.render(width)
			.map((line: string) =>
				visibleWidth(line) > width ? truncateToWidth(line, width, "") : line,
			);
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

// ============================================================================
// Public entry point
// ============================================================================

export interface LocalPickerCallbacks {
	/** Called when user presses l/u on a model. Return refreshed result to continue, or undefined to close. */
	onLoadUnload(
		model: DiscoveredModel,
		action: "load" | "unload",
	): Promise<QueryResult | undefined>;
}

/**
 * Show a custom model picker with load/unload support.
 *
 * Works like the claude-local bash script's interactive loop:
 * 1. Show model list with status header
 * 2. l/u → load/unload model, re-query, show refreshed list (loop)
 * 3. Enter → return selected model
 * 4. Esc → return undefined
 */
export async function showLocalPicker(
	ctx: ExtensionCommandContext,
	baseUrl: string,
	queryModels: () => Promise<QueryResult>,
	callbacks: LocalPickerCallbacks,
	currentModelId?: string,
): Promise<DiscoveredModel | undefined> {
	let result = await queryModels();
	if (!result.models.length) {
		ctx.ui.notify("No models found on this connection.", "error");
		return undefined;
	}

	let lastSelectedId = currentModelId;

	while (true) {
		const action = await ctx.ui.custom<LocalPickerAction>(
			(tui, theme, _keybindings, done) => {
				const view = new LocalPickerView(
					tui,
					(c, t) => theme.fg(c, t),
					(t) => theme.bold(t),
					done,
					baseUrl,
					result,
					lastSelectedId,
				);
				return view;
			},
		);

		if (!action || action.type === "close") {
			return undefined;
		}

		if (action.type === "select") {
			return action.model;
		}

		if (action.type === "load" || action.type === "unload") {
			lastSelectedId = action.model.id;
			const model = action.model;
			const label = action.type === "load" ? "Loading" : "Unloading";
			ctx.ui.notify(`${label} ${model.displayName}...`);

			const refreshed = await callbacks.onLoadUnload(model, action.type);
			if (!refreshed) {
				ctx.ui.notify("Failed to refresh model list.", "error");
				return undefined;
			}
			result = refreshed;
		}
	}
}
