import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface StoredConnection {
	baseUrl: string;
	apiKey: string;
	/** All known models from the last successful query, keyed by id. */
	knownModels?: Record<
		string,
		{
			displayName: string;
			contextWindow?: number;
			maxTokens?: number;
			reasoning?: boolean;
			modelType?: string;
			pinned?: boolean;
			favorite?: boolean;
		}
	>;
}

/** Resolve an API key that may be a direct key, $ENV_VAR, or !command. */
export function resolveApiKey(raw: string): string {
	if (!raw) return "";
	if (raw.startsWith("!")) {
		const command = raw.slice(1).trim();
		try {
			return execSync(command, { encoding: "utf-8", timeout: 10000 }).trim();
		} catch {
			return "";
		}
	}
	if (raw.startsWith("$")) {
		const varName = raw.replace(/^\$\{?/, "").replace(/\}$/, "");
		return process.env[varName] ?? "";
	}
	return raw;
}

function connectionsPath(): string {
	const agentDir = getAgentDir();
	return join(agentDir, "pi-local-connections.json");
}

interface ConnectionsData {
	connections: Record<string, Omit<StoredConnection, "baseUrl">>;
}

function loadConnectionsData(): ConnectionsData {
	const path = connectionsPath();
	if (!existsSync(path)) return { connections: {} };
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as ConnectionsData;
	} catch {
		return { connections: {} };
	}
}

function saveConnectionsData(data: ConnectionsData): void {
	const path = connectionsPath();
	writeFileSync(path, JSON.stringify(data, null, 2));
}

export function addConnection(
	baseUrl: string,
	apiKeyCommand: string,
	options?: { knownModels?: StoredConnection["knownModels"] },
): void {
	const data = loadConnectionsData();
	data.connections[baseUrl] = {
		apiKey: apiKeyCommand,
		knownModels: options?.knownModels ?? data.connections[baseUrl]?.knownModels,
	};
	saveConnectionsData(data);
}

export function removeConnection(baseUrl: string): void {
	const data = loadConnectionsData();
	delete data.connections[baseUrl];
	saveConnectionsData(data);
}

export function listConnections(): StoredConnection[] {
	const data = loadConnectionsData();
	const connections: StoredConnection[] = [];

	for (const baseUrl of Object.keys(data.connections)) {
		if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) continue;
		const entry = data.connections[baseUrl];
		connections.push({ baseUrl, apiKey: entry.apiKey, knownModels: entry.knownModels });
	}

	return connections;
}

export function getConnection(baseUrl: string): StoredConnection | undefined {
	const data = loadConnectionsData();
	const entry = data.connections[baseUrl];
	if (!entry) return undefined;
	return { baseUrl, apiKey: entry.apiKey, knownModels: entry.knownModels };
}
