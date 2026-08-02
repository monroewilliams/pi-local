import { platform } from "node:os";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createLocalProvider, providerDisplayName } from "./src/provider.ts";
import {
	DEFAULT_LOCAL_BASE_URL,
	isDirectKey,
	keychainStoreCommand,
	normalizeBaseUrl,
} from "./src/config.ts";
import type { DiscoveredModel } from "./src/model-picker.ts";
import { queryConnection } from "./src/model-picker.ts";
import {
	addConnection,
	getConnection,
	listConnections,
	removeConnection,
	resolveApiKey,
	type StoredConnection,
} from "./src/connections.ts";

// ============================================================================
// Helpers
// ============================================================================

function toProviderModel(
	baseUrl: string,
	id: string,
	meta: NonNullable<StoredConnection["knownModels"]>[string],
): Model<"openai-completions"> {
	return {
		id,
		name: meta.displayName,
		api: "openai-completions",
		provider: baseUrl,
		baseUrl: `${baseUrl}/v1`,
		reasoning: meta.reasoning ?? false,
		input: meta.modelType?.includes("vlm") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: meta.contextWindow ?? 128000,
		maxTokens: meta.maxTokens ?? 16384,
	};
}

// ============================================================================
// Startup: register all known connections as providers
// ============================================================================

function registerAllConnections(pi: ExtensionAPI): void {
	try {
		const connections = listConnections();
		for (const conn of connections) {
			try {
				// Build initial models from cached knownModels
				const initialModels: Model<"openai-completions">[] = [];
				if (conn.knownModels) {
					for (const [id, meta] of Object.entries(conn.knownModels)) {
						initialModels.push(toProviderModel(conn.baseUrl, id, meta));
					}
				}

			const provider = createLocalProvider(
				conn.baseUrl,
				conn.apiKey,
				resolveApiKey,
				async (url: string, key: string) => {
					try {
						return await queryConnection(url, key);
					} catch {
						// Return cached models on network failure
						const stored = getConnection(url);
						const models: DiscoveredModel[] = [];
						if (stored?.knownModels) {
							for (const [id, meta] of Object.entries(stored.knownModels)) {
					models.push({ id, displayName: meta.displayName, description: meta.displayName, loaded: false, contextWindow: meta.contextWindow, maxTokens: meta.maxTokens, reasoning: meta.reasoning, modelType: meta.modelType });
							}
						}
						return { apiType: "openai" as const, models };
					}
				},
				initialModels,
			);
				pi.registerProvider(provider);
			} catch {
				// Skip broken connections silently
			}
		}
	} catch {
		// No connections file yet — fine
	}
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI): void {
	// Register all known connections at startup
	registerAllConnections(pi);

	//
	pi.registerCommand("local-endpoints", {
		description: "Configure local LLM connections (base URL + API key)",
		handler: async (_args, ctx) => {
			let running = true;
			while (running) {
				const connections = listConnections();
				const options =
					connections.length > 0
						? [
								...connections.map((c) => `Remove: ${c.baseUrl}`),
								"",
								"Add new connection",
								"",
								"Done",
							]
						: ["Add new connection", "", "Done"];

				const choice = await ctx.ui.select("Manage Connections", options);
				if (!choice) break;

				if (choice === "Add new connection") {
					const added = await addConnectionFlow(ctx, pi);
					if (added) running = false; // Exit after adding one
				} else if (choice === "Done") {
					running = false;
				} else if (choice.startsWith("Remove: ")) {
					const baseUrl = choice.slice("Remove: ".length);
					const confirmed = await ctx.ui.confirm(
						"Remove connection",
						`Remove "${baseUrl}"?`,
					);
					if (confirmed) {
						// Delete keychain entry if this connection used our security command
						const conn = getConnection(baseUrl);
						const prefix = `!security add-generic-password -s 'pi-local' -a '${baseUrl}' -w '`;
						if (conn?.apiKey?.startsWith(prefix)) {
							try {
								const { exec } = await import("node:child_process");
								const { promisify } = await import("node:util");
								await promisify(exec)(
									`security delete-generic-password -s 'pi-local' -a '${baseUrl}'`,
								);
							} catch {
								// Ignore errors — keychain entry may not exist
							}
						}
						removeConnection(baseUrl);
						pi.unregisterProvider(baseUrl);
					}
				}
			}
		},
	});

	// /local-model: Select a connection, then the custom model picker
	pi.registerCommand("local-model", {
		description: "Select a local connection and model",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/local-model requires interactive mode", "warning");
				return;
			}

			const storedConnections = listConnections();
			if (storedConnections.length === 0) {
				ctx.ui.notify("No connections configured. Run /local-endpoints first.");
				return;
			}

			// Resolve API keys for all connections
			const resolvedConnections = storedConnections.map((conn) => ({
				baseUrl: conn.baseUrl,
				apiKey: resolveApiKey(conn.apiKey),
				apiKeyCommand: conn.apiKey,
			}));

			if (resolvedConnections.length === 0) {
				ctx.ui.notify(
					"No connections with resolvable API keys. Check your keychain.",
					"error",
				);
				return;
			}

			// If multiple connections, let user pick one first
			let selectedConn: typeof resolvedConnections[0];
			if (resolvedConnections.length > 1) {
				const connLabels = resolvedConnections.map((c) =>
					c.baseUrl.includes("127.0.0.1") || c.baseUrl.includes("localhost")
						? providerDisplayName(c.baseUrl)
						: c.baseUrl,
				);
				const chosen = await ctx.ui.select(
					"Select a connection",
					connLabels,
				);
				if (!chosen) return;
				const idx = connLabels.indexOf(chosen);
				if (idx === -1) return;
				selectedConn = resolvedConnections[idx];
			} else {
				selectedConn = resolvedConnections[0];
			}

			// Lazy-import heavy modules
			const { queryConnection, loadModel, unloadModel } = await import(
				"./src/model-picker.ts"
			);
			const { showLocalPicker } = await import("./src/ui.ts");

			const queryModels = async () =>
				queryConnection(selectedConn.baseUrl, selectedConn.apiKey);

			// Pre-select the currently active model
			const settings = SettingsManager.create(process.cwd(), getAgentDir());
			const currentModelId = settings.getDefaultModel();

			// Open the custom picker
			const model = await showLocalPicker(
				ctx,
				selectedConn.baseUrl,
				queryModels,
				{
					onLoadUnload: async (model, action) => {
						const current = await queryConnection(
							selectedConn.baseUrl,
							selectedConn.apiKey,
						);

						const response =
							action === "load"
								? await loadModel(
										selectedConn.baseUrl,
										selectedConn.apiKey,
										model.id,
										current.apiType,
									)
								: await unloadModel(
										selectedConn.baseUrl,
										selectedConn.apiKey,
										model.id,
										current.apiType,
									);

						if (
							response &&
							typeof response === "object" &&
							"error" in response
						) {
							ctx.ui.notify(
								`Error: ${String((response as Record<string, unknown>).error)}`,
								"error",
							);
						}

						return queryConnection(
							selectedConn.baseUrl,
							selectedConn.apiKey,
						);
					},
				},
				currentModelId,
			);

			if (!model) return;

			// Get fresh model list and sync knownModels to storage
			const refreshed = await queryConnection(
				selectedConn.baseUrl,
				selectedConn.apiKey,
			);
			const knownModels: Record<string, NonNullable<StoredConnection["knownModels"]>[string]> = {};
			for (const m of refreshed.models) {
				knownModels[m.id] = {
					displayName: m.displayName,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
					reasoning: m.reasoning,
					modelType: m.modelType,
				};
			}
			addConnection(selectedConn.baseUrl, selectedConn.apiKeyCommand, {
				knownModels,
			});

			// Re-register provider with full model list (so /model sees all of them)
			const initialModels = refreshed.models.map((m) =>
				toProviderModel(selectedConn.baseUrl, m.id, knownModels[m.id]!),
			);
			const provider = createLocalProvider(
				selectedConn.baseUrl,
				selectedConn.apiKeyCommand,
				resolveApiKey,
				async (url: string, key: string) =>
					queryConnection(url, key),
				initialModels,
			);
			pi.registerProvider(provider);

			// Set active model
			const inputTypes: Array<"text" | "image"> = model.modelType?.includes("vlm")
				? ["text", "image"]
				: ["text"];

			const success = await pi.setModel({
				id: model.id,
				name: model.displayName,
				api: "openai-completions",
				provider: selectedConn.baseUrl,
				baseUrl: `${selectedConn.baseUrl}/v1`,
				reasoning: model.reasoning ?? false,
				input: inputTypes,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: model.contextWindow ?? 128000,
				maxTokens: model.maxTokens ?? 16384,
			});

			if (success) {
				ctx.ui.notify(`Using model: ${model.displayName}`);
			} else {
				ctx.ui.notify("Failed to set model.", "error");
			}
		},
	});
}

// ============================================================================
// Add connection flow
// ============================================================================

async function addConnectionFlow(
	ctx: Parameters<
		NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>
	>[1],
	pi: ExtensionAPI,
): Promise<boolean> {
	const rawUrl = await ctx.ui.input("Base URL", DEFAULT_LOCAL_BASE_URL);
	if (!rawUrl) return false;
	const baseUrl = normalizeBaseUrl(rawUrl);

	let apiKey = await ctx.ui.input(
		"API key (leave empty for no auth, or enter direct key / $ENV_VAR / !command)",
		"",
	);
	if (apiKey === undefined) return false;

	// On macOS, if user entered a direct key, offer to store in keychain
	if (platform() === "darwin" && isDirectKey(apiKey)) {
		const storeInKeychain = await ctx.ui.confirm(
			"Store in keychain",
			`Store this API key in the macOS keychain and use a !security command in the config?`,
		);
		if (storeInKeychain) {
			const { exec } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execAsync = promisify(exec);
			try {
				await execAsync(
					`security delete-generic-password -s 'pi-local' -a '${baseUrl}'`,
				);
			} catch {
				// Entry may not exist — ignore
			}
			const storeCmd = keychainStoreCommand(baseUrl, apiKey);
			try {
				await execAsync(storeCmd);
				apiKey = `!security find-generic-password -s 'pi-local' -a '${baseUrl}' -w`;
				ctx.ui.notify("API key stored in keychain.");
			} catch {
				ctx.ui.notify(
					"Failed to store in keychain. Using direct key instead.",
					"warning",
				);
			}
		}
	}

	addConnection(baseUrl, apiKey);

	// Register the new connection as a provider so it appears in /model
	try {
		const provider = createLocalProvider(
			baseUrl,
			apiKey,
			resolveApiKey,
			async () => ({ apiType: "openai" as const, models: [] }),
		);
		pi.registerProvider(provider);
	} catch {
		// Will be registered next startup
	}

	ctx.ui.notify(`Added connection "${baseUrl}"`);
	return true;
}
