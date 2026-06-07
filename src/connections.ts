import type { AuthCredential } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent";

export interface StoredConnection {
	baseUrl: string;
	apiKey: string;
	model?: {
		id: string;
		displayName: string;
		contextWindow?: number;
		maxTokens?: number;
		reasoning?: boolean;
	};
}

function getStorage(): AuthStorage {
	return AuthStorage.create();
}

function hasCredential(
	cred: ReturnType<AuthStorage["get"]>,
): cred is { type: "api_key"; key: string } {
	return !!(cred && cred.type === "api_key");
}

export function addConnection(
	baseUrl: string,
	apiKeyCommand: string,
	model?: StoredConnection["model"],
): void {
	const storage = getStorage();
	const cred = {
		type: "api_key" as const,
		key: apiKeyCommand,
		...(model && { model }),
	} satisfies {
		type: "api_key";
		key: string;
		model?: StoredConnection["model"];
	};
	storage.set(baseUrl, cred as AuthCredential);
}

export function removeConnection(baseUrl: string): void {
	const storage = getStorage();
	storage.remove(baseUrl);
}

export function listConnections(): StoredConnection[] {
	const storage = getStorage();
	const all = storage.list();
	const connections: StoredConnection[] = [];

	for (const key of all) {
		// Only treat URL-like keys as local connections
		// Built-in providers use slugs like "anthropic", "openai", etc.
		if (!key.startsWith("http://") && !key.startsWith("https://")) continue;
		const cred = storage.get(key);
		if (!hasCredential(cred)) continue;
		const raw = cred as Record<string, unknown>;
		connections.push({
			baseUrl: key,
			apiKey: cred.key,
			model: raw.model as StoredConnection["model"],
		});
	}

	return connections;
}

export function getConnection(baseUrl: string): StoredConnection | undefined {
	const storage = getStorage();
	const cred = storage.get(baseUrl);
	if (!hasCredential(cred)) return undefined;
	const raw = cred as Record<string, unknown>;
	return {
		baseUrl,
		apiKey: cred.key,
		model: raw.model as StoredConnection["model"],
	};
}
