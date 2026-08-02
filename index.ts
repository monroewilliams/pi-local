import { platform } from "node:os";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalProvider, providerDisplayName } from "./src/provider.ts";
import {
	DEFAULT_LOCAL_BASE_URL,
	isDirectKey,
	keychainStoreCommand,
	normalizeBaseUrl,
} from "./src/config.ts";
import type { DiscoveredModel } from "./src/model-picker.ts";
import {
	addConnection,
	getConnection,
	listConnections,
	removeConnection,
	resolveApiKey,
} from "./src/connections.ts";

// ============================================================================
// Startup: register all known connections as providers
// ============================================================================

function registerAllConnections(pi: ExtensionAPI): void {
	try {
		const connections = listConnections();
		for (const conn of connections) {
			try {
				const provider = createLocalProvider(
					conn.baseUrl,
					conn.apiKey,
					resolveApiKey,
					async (url: string, _key: string) => {
						// At startup we skip network queries — providers will refresh on demand
						// when the user opens /model or /local-model.
						// Return cached model from saved metadata if available.
						const stored = getConnection(url);
						if (stored?.model) {
							return {
								apiType: "openai" as const,
								models: [
									{
										id: stored.model.id,
										displayName: stored.model.displayName,
										description: stored.model.displayName,
										loaded: false,
										contextWindow: stored.model.contextWindow,
										maxTokens: stored.model.maxTokens,
										reasoning: stored.model.reasoning,
										modelType: stored.model.modelType,
									},
								],
							};
						}
						return { apiType: "openai" as const, models: [] };
					},
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
// Startup: restore saved default model
// ============================================================================

function restoreDefaultModel(pi: ExtensionAPI): void {
	try {
		const settings = SettingsManager.create(process.cwd(), getAgentDir());
		const savedProvider = settings.getDefaultProvider();
		const savedModelId = settings.getDefaultModel();

		if (!savedProvider || !savedModelId) return;
		if (
			!savedProvider.startsWith("http://") &&
			!savedProvider.startsWith("https://")
		) return;

		const storedConn = getConnection(savedProvider);
		if (!storedConn) return;

		// Build model from saved metadata
		const savedModel = storedConn.model;
		const model: DiscoveredModel =
			savedModel && savedModel.id === savedModelId
				? {
						id: savedModel.id,
						displayName: savedModel.displayName,
						description: savedModel.displayName,
						loaded: false,
						contextWindow: savedModel.contextWindow,
						maxTokens: savedModel.maxTokens,
						reasoning: savedModel.reasoning,
						modelType: savedModel.modelType,
					}
				: {
						id: savedModelId,
						displayName: savedModelId,
						description: savedModelId,
						loaded: false,
					};

		const provider = createLocalProvider(
			savedProvider,
			storedConn.apiKey,
			resolveApiKey,
			async () => ({ apiType: "openai" as const, models: [model] }),
		);
		pi.registerProvider(provider);
	} catch {
		// Silently fail — /local-model still works manually
	}
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI): void {
	// Register all known connections at startup
	registerAllConnections(pi);

	// Restore saved default model (overwrites the cached-only registration above)
	restoreDefaultModel(pi);

	// /local-endpoints: Add or remove connections (renamed from /local-login)
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
			);

			if (!model) return;

			// Save model metadata to the connection
			addConnection(selectedConn.baseUrl, selectedConn.apiKeyCommand, {
				id: model.id,
				displayName: model.displayName,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				reasoning: model.reasoning,
				modelType: model.modelType,
			});

			// Register provider with full model list (so /model sees all of them)
			const refreshed = await queryConnection(
				selectedConn.baseUrl,
				selectedConn.apiKey,
			);
			const provider = createLocalProvider(
				selectedConn.baseUrl,
				selectedConn.apiKeyCommand,
				resolveApiKey,
				async (url: string, key: string) =>
					queryConnection(url, key),
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
