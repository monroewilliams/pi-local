import { platform } from "node:os";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toProviderConfig } from "./src/provider.ts";
import {
	DEFAULT_LOCAL_BASE_URL,
	isDirectKey,
	keychainStoreCommand,
	normalizeBaseUrl,
} from "./src/config.ts";
import {
	addConnection,
	getConnection,
	listConnections,
	removeConnection,
} from "./src/connections.ts";

export default function (pi: ExtensionAPI): void {
	// Auto-register the saved default model at startup so Pi can restore it.
	// Reads defaultProvider/defaultModel from settings.json, looks up the
	// connection in auth.json, and registers a minimal provider config.
	// Synchronous registration ensures Pi sees models at startup.
	try {
		const settings = SettingsManager.create(
			process.cwd(),
			getAgentDir(),
		);
		const savedProvider = settings.getDefaultProvider();
		const savedModelId = settings.getDefaultModel();
		if (savedProvider && savedModelId) {
			// Only register if the default provider looks like a local URL
			if (
				savedProvider.startsWith("http://") ||
				savedProvider.startsWith("https://")
			) {
				const storedConn = getConnection(savedProvider);
				if (storedConn) {
					// Use saved model metadata if available and matches the default model
					const savedModel = storedConn.model;
					const model =
						savedModel && savedModel.id === savedModelId
							? {
									id: savedModel.id,
									displayName: savedModel.displayName,
									description: savedModel.displayName,
									loaded: false,
									contextWindow: savedModel.contextWindow,
									maxTokens: savedModel.maxTokens,
									reasoning: savedModel.reasoning,
								}
							: {
									id: savedModelId,
									displayName: savedModelId,
									description: savedModelId,
									loaded: false,
								};

					const providerConfig = toProviderConfig(
						[model],
						savedProvider,
						storedConn.apiKey,
					);
					pi.registerProvider(savedProvider, providerConfig);
				}
			}
		}
	} catch {
		// Silently fail — /local-model still works manually
	}

	// /local-login: Add or remove connections
	pi.registerCommand("local-login", {
		description: "Configure a local LLM connection (base URL + API key)",
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
					await addConnectionFlow(ctx);
				} else if (choice === "Done") {
					running = false;
				} else if (choice.startsWith("Remove: ")) {
					// Parse baseUrl from "Remove: http://..."
					const baseUrl = choice.slice("Remove: ".length);
					const confirmed = await ctx.ui.confirm(
						"Remove connection",
						`Remove "${baseUrl}"?`,
					);
					if (confirmed) {
						// Delete keychain entry if this connection used our security command
						const connections = listConnections();
						const conn = connections.find((c) => c.baseUrl === baseUrl);
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
					}
				}
			}
		},
	});

	// /local-model: Select a connection, then select a model
	pi.registerCommand("local-model", {
		description: "Select a local connection and model",
		handler: async (_args, ctx) => {
			const storedConnections = listConnections();
			if (storedConnections.length === 0) {
				ctx.ui.notify("No connections configured. Run /local-login first.");
				return;
			}

			// Resolve API keys for all connections
			const { AuthStorage } = await import("@earendil-works/pi-coding-agent");
			const storage = AuthStorage.create();

			const resolvedConnections: Array<{
				baseUrl: string;
				apiKey: string;
				apiKeyCommand: string;
			}> = [];

			const keyPromises = storedConnections.map(async (conn) => {
				const apiKey = await storage.getApiKey(conn.baseUrl, {
					includeFallback: false,
				});
				// apiKey can be "" for no-auth connections, or undefined if keychain lookup failed
				if (apiKey !== undefined) {
					const cred = storage.get(conn.baseUrl);
					const apiKeyCommand =
						cred?.type === "api_key" ? (cred.key ?? "") : "";
					resolvedConnections.push({
						baseUrl: conn.baseUrl,
						apiKey,
						apiKeyCommand,
					});
				}
			});
			await Promise.all(keyPromises);

			if (resolvedConnections.length === 0) {
				ctx.ui.notify(
					"No connections with resolvable API keys. Check your keychain.",
					"error",
				);
				return;
			}

			// If multiple connections, let user pick one first
			let selectedConnection: (typeof resolvedConnections)[0];
			if (resolvedConnections.length > 1) {
				const connOptions = resolvedConnections.map((c) => c.baseUrl);
				const chosen = await ctx.ui.select("Select a connection", connOptions);
				if (!chosen) return;
				const idx = connOptions.indexOf(chosen);
				if (idx === -1) return;
				selectedConnection = resolvedConnections[idx];
			} else {
				selectedConnection = resolvedConnections[0];
			}

			// Query models with rich info (omlx → lmstudio → openai fallback)
			ctx.ui.setStatus("local-model", "Querying connection...");
			const { queryConnection, loadModel, unloadModel } = await import(
				"./src/model-picker.ts"
			);
			const result = await queryConnection(
				selectedConnection.baseUrl,
				selectedConnection.apiKey,
			);
			ctx.ui.setStatus("local-model", undefined);

			if (result.models.length === 0) {
				ctx.ui.notify("No models found on this connection.", "error");
				return;
			}

			// Interactive model selection loop
			let running = true;
			while (running) {
				const options = [
					...result.models.map((m) => m.description),
					"",
					...(result.apiType === "omlx" || result.apiType === "lmstudio"
						? ["Load / Unload model"]
						: []),
					"",
					"Done",
				];

				let title = `using base url: ${selectedConnection.baseUrl}`;
				if (result.apiType === "omlx" && result.status) {
					title += `\noMLX ${result.status.version}: ${result.status.models_loaded}/${result.status.models_discovered} loaded, ${result.status.models_loading} loading, using ${result.status.model_memory_used_formatted} of ${result.status.model_memory_max_formatted}`;
				}
				title += "\nAvailable Models:";
				const choice = await ctx.ui.select(title, options);
				if (!choice) break;

				if (choice === "Done") {
					running = false;
				} else if (choice === "Load / Unload model") {
					// Show model list for load/unload
					const loadUnloadOptions = result.models.map((m) =>
						m.loaded ? `Unload: ${m.displayName}` : `Load: ${m.displayName}`,
					);
					const luChoice = await ctx.ui.select(
						"Load / Unload",
						loadUnloadOptions,
					);
					if (!luChoice) continue;

					const modelIdx = loadUnloadOptions.indexOf(luChoice);
					if (modelIdx === -1) continue;
					const model = result.models[modelIdx];

					const action = model.loaded ? "unload" : "load";
					const success = model.loaded
						? await unloadModel(
								selectedConnection.baseUrl,
								selectedConnection.apiKey,
								model.id,
								result.apiType,
							)
						: await loadModel(
								selectedConnection.baseUrl,
								selectedConnection.apiKey,
								model.id,
								result.apiType,
							);

					if (success) {
						ctx.ui.notify(
							`${action === "load" ? "Loaded" : "Unloaded"}: ${model.displayName}`,
						);
						// Re-query to refresh model list
						ctx.ui.setStatus("local-model", "Refreshing...");
						const refreshed = await queryConnection(
							selectedConnection.baseUrl,
							selectedConnection.apiKey,
						);
						ctx.ui.setStatus("local-model", undefined);
						result.models = refreshed.models;
						result.status = refreshed.status;
						result.apiType = refreshed.apiType;
					} else {
						ctx.ui.notify(`Failed to ${action} model.`, "error");
					}
				} else {
					// Model selected
					const modelIdx = result.models.findIndex(
						(m) => m.description === choice,
					);
					if (modelIdx === -1) continue;
					const model = result.models[modelIdx];

					// Save model metadata to the connection
					addConnection(
						selectedConnection.baseUrl,
						selectedConnection.apiKeyCommand,
						{
							id: model.id,
							displayName: model.displayName,
							contextWindow: model.contextWindow,
							maxTokens: model.maxTokens,
							reasoning: model.reasoning,
						},
					);

					// Register provider with the selected connection
					const { toProviderConfig } = await import("./src/provider.ts");
					const providerConfig = toProviderConfig(
						[model],
						selectedConnection.baseUrl,
						selectedConnection.apiKeyCommand,
					);
					pi.registerProvider(selectedConnection.baseUrl, providerConfig);

					// Set active model
					const success = await pi.setModel({
						id: model.id,
						name: model.displayName,
						api: "openai-completions",
						provider: selectedConnection.baseUrl,
						baseUrl: `${selectedConnection.baseUrl}/v1`,
						reasoning: model.reasoning ?? false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: model.contextWindow ?? 128000,
						maxTokens: model.maxTokens ?? 16384,
					});

					if (success) {
						ctx.ui.notify(`Using model: ${model.displayName}`);
					} else {
						ctx.ui.notify("Failed to set model.", "error");
					}
					running = false;
				}
			}
		},
	});
}

async function addConnectionFlow(
	ctx: Parameters<
		NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>
	>[1],
): Promise<void> {
	const rawUrl = await ctx.ui.input("Base URL", DEFAULT_LOCAL_BASE_URL);
	if (!rawUrl) return;
	const baseUrl = normalizeBaseUrl(rawUrl);

	let apiKey = await ctx.ui.input(
		"API key (leave empty for no auth, or enter direct key / $ENV_VAR / !command)",
		"",
	);
	if (apiKey === undefined) return;

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
			// Delete any existing entry first (ignore errors — may not exist)
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
	const connections = listConnections();
	ctx.ui.notify(`Added connection "${baseUrl}" (${connections.length} total)`);
}
