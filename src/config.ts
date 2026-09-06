export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:1234";

export function normalizeBaseUrl(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (!trimmed) throw new Error("Base URL is empty");
	// Strip trailing /v1. It gets added per endpoint where needed.
	return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

/**
 * Provider id for a connection.
 *
 * Some clients unpack a model reference of the form "provider/model" at the
 * first slash (pi-acp does), so a base URL used verbatim would split on the
 * slashes in its own scheme. Dropping just the two slashes keeps it whole:
 * "http://host:8000" becomes "http:host:8000", which still distinguishes
 * http from https.
 */
export function encodeProviderId(baseUrl: string): string {
	return baseUrl.replace(/^(https?):\/\//, "$1:");
}

/** Inverse of encodeProviderId; a no-op on an id that kept its slashes. */
export function decodeProviderId(providerId: string): string {
	return providerId.replace(/^(https?):(?!\/\/)/, "$1://");
}

/**
 * API keys are stored in the connection record in any of the formats pi
 * accepts: a direct key ("sk-..."), an environment reference ("$MY_KEY" or
 * "${MY_KEY}"), a command ("!security find-generic-password ..."), or empty
 * for no authentication.
 */

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
