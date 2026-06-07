export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:1234";

export function normalizeBaseUrl(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (!trimmed) throw new Error("Base URL is empty");
	// Strip trailing /v1 — it's added per-endpoint where needed
	return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

/**
 * Default key format. Always empty — the user types their key
 * (or leaves blank for no auth).
 *
 * Supports all auth key formats (same as regular Pi auth):
 * - Direct key: "sk-1234567890abcdef"
 * - Env var: "$MY_API_KEY" or "${MY_API_KEY}"
 * - Command: "!security find-generic-password ..."
 * - Empty string for no authentication
 */
export function defaultKeyFormat(): string {
	return "";
}

/**
 * Build the security add-generic-password command to store a key in the macOS keychain.
 */
export function keychainStoreCommand(baseUrl: string, apiKey: string): string {
	return `security add-generic-password -s 'pi-local' -a '${baseUrl}' -w '${apiKey}'`;
}

/**
 * Check if a key value looks like a direct API key (not a $VAR or !command reference).
 */
export function isDirectKey(key: string): boolean {
	if (!key) return false;
	if (key.startsWith("!")) return false;
	if (key.startsWith("$")) return false;
	if (key.startsWith("#")) return false;
	return true;
}
