import { describe, expect, it } from "vitest";
import { decodeProviderId, encodeProviderId } from "../src/config.ts";
import type { DiscoveredModel } from "../src/model-picker.ts";
import { toModel } from "../src/provider.ts";

const BASE_URLS = [
	"http://127.0.0.1:1234",
	"http://localhost:8000",
	"http://server.localdomain:8000",
	"https://gpu.example.com",
];

describe("encodeProviderId", () => {
	it("round-trips every base URL shape we register", () => {
		for (const url of BASE_URLS) {
			expect(decodeProviderId(encodeProviderId(url))).toBe(url);
		}
	});

	it("keeps the scheme distinct", () => {
		expect(encodeProviderId("http://host:8000")).toBe("http:host:8000");
		expect(encodeProviderId("https://host:8000")).toBe("https:host:8000");
	});

	it("produces ids with no slash, so a first-slash split can't cut one", () => {
		for (const url of BASE_URLS) {
			expect(encodeProviderId(url)).not.toContain("/");
		}
	});

	it("leaves an already-decoded id alone", () => {
		expect(decodeProviderId("http://host:8000")).toBe("http://host:8000");
	});
});

describe("provider/model references", () => {
	const base: DiscoveredModel = {
		id: "test-model",
		displayName: "Test Model",
		description: "",
		loaded: false,
	};

	// How pi-acp packs and unpacks a model reference. Model ids may contain
	// slashes ("google/gemma-4-12b-qat"), so only the first one is a delimiter.
	const pack = (provider: string, id: string) => `${provider}/${id}`;
	const unpack = (ref: string) => {
		const [provider, ...rest] = ref.split("/");
		return { provider, id: rest.join("/") };
	};

	it("survives a first-slash split for plain and slash-bearing model ids", () => {
		for (const url of BASE_URLS) {
			for (const id of ["Qwen3.8-27B-oQ8e-mtp", "google/gemma-4-12b-qat"]) {
				const model = toModel({ ...base, id }, url);
				expect(unpack(pack(model.provider, model.id))).toEqual({
					provider: model.provider,
					id,
				});
			}
		}
	});

	it("still targets the real URL, scheme intact", () => {
		const model = toModel(base, "https://gpu.example.com");
		expect(model.provider).toBe("https:gpu.example.com");
		expect(model.baseUrl).toBe("https://gpu.example.com/v1");
	});
});
