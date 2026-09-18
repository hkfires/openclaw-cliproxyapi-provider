import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildInputModalities,
	CONFIG_FILE_NAME,
	classifyModel,
	createDynamicModel,
	DEFAULT_API_DRIVER,
	DEFAULT_BASE_URL,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	DEFAULT_PROVIDER_ID,
	DEFAULT_PROVIDER_NAME,
	extractReasoningEfforts,
	fetchCodexModels,
	firstNonEmpty,
	isUnauthorizedModelsError,
	loadConfigFile,
	loadModelsCache,
	ModelsHttpError,
	matchModelCost,
	OPENCLAW_API_DRIVER,
	parseBooleanSetting,
	resolveApiDriver,
	resolveConnection,
	resolveEndpoints,
	resolveFastDefault,
	resolveIdentity,
	resolveModelLimits,
	saveConfigFile,
	saveModelsCache,
	stripReasoningOrTierSuffix,
	supportsFastServiceTier,
	toOpenClawModel,
	ZERO_COST,
} from "../src/lib.js";
import type { CodexClientModel, ModelsDevCostCatalog } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function tempTestDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "openclaw-cliproxyapi-test-"));
	tempDirs.push(dir);
	return dir;
}

describe("firstNonEmpty", () => {
	it("returns the first non-empty trimmed string", () => {
		expect(firstNonEmpty("  ", undefined, null, " alpha ", "beta")).toBe("alpha");
	});

	it("returns undefined when all values are empty", () => {
		expect(firstNonEmpty("", "   ", undefined, null)).toBeUndefined();
	});
});

describe("resolveEndpoints", () => {
	it("normalizes standard host:port input to /v1 inference and /v1/models catalog", () => {
		const result = resolveEndpoints("http://127.0.0.1:8317");
		expect(result).toEqual({
			inferenceBaseUrl: "http://127.0.0.1:8317/v1",
			modelsUrl: "http://127.0.0.1:8317/v1/models?client_version=openclaw",
			rootOrigin: "http://127.0.0.1:8317",
		});
	});

	it("preserves explicit /v1 path without duplicating", () => {
		const result = resolveEndpoints("http://127.0.0.1:8317/v1");
		expect(result.inferenceBaseUrl).toBe("http://127.0.0.1:8317/v1");
		expect(result.modelsUrl).toBe("http://127.0.0.1:8317/v1/models?client_version=openclaw");
	});

	it("rewrites /backend-api to /v1 for Responses", () => {
		const result = resolveEndpoints("http://127.0.0.1:8317/backend-api");
		expect(result.inferenceBaseUrl).toBe("http://127.0.0.1:8317/v1");
		expect(result.modelsUrl).toBe("http://127.0.0.1:8317/v1/models?client_version=openclaw");
	});

	it("adds http scheme when missing", () => {
		const result = resolveEndpoints("127.0.0.1:8317");
		expect(result.inferenceBaseUrl).toBe("http://127.0.0.1:8317/v1");
		expect(result.modelsUrl).toBe("http://127.0.0.1:8317/v1/models?client_version=openclaw");
	});

	it("throws on empty baseUrl", () => {
		expect(() => resolveEndpoints("   ")).toThrow(/baseUrl is empty/);
	});
});

describe("config file I/O", () => {
	it("returns empty object when config file is missing", () => {
		const dir = tempTestDir();
		expect(loadConfigFile(dir)).toEqual({});
	});

	it("saves and reloads config settings", () => {
		const dir = tempTestDir();
		saveConfigFile(dir, {
			baseUrl: "http://localhost:9000",
			apiKey: "test-secret-key",
			fast: true,
			providerId: "custom-cpa",
		});

		const loaded = loadConfigFile(dir);
		expect(loaded).toEqual({
			baseUrl: "http://localhost:9000",
			apiKey: "test-secret-key",
			fast: true,
			providerId: "custom-cpa",
		});
	});

	it("throws when config file is invalid JSON or non-object", () => {
		const dir = tempTestDir();
		writeFileSync(join(dir, CONFIG_FILE_NAME), "invalid json", "utf8");
		expect(() => loadConfigFile(dir)).toThrow();

		writeFileSync(join(dir, CONFIG_FILE_NAME), "[]", "utf8");
		expect(() => loadConfigFile(dir)).toThrow(/must contain a JSON object/);
	});
});

describe("resolveFastDefault & parseBooleanSetting", () => {
	it("parses boolean equivalents correctly", () => {
		expect(parseBooleanSetting("1")).toBe(true);
		expect(parseBooleanSetting("true")).toBe(true);
		expect(parseBooleanSetting("YES")).toBe(true);
		expect(parseBooleanSetting("on")).toBe(true);

		expect(parseBooleanSetting("0")).toBe(false);
		expect(parseBooleanSetting("false")).toBe(false);
		expect(parseBooleanSetting("no")).toBe(false);
		expect(parseBooleanSetting("off")).toBe(false);

		expect(parseBooleanSetting("invalid")).toBeUndefined();
	});

	it("prefers CLIPROXYAPI_FAST env var over file setting", () => {
		const prev = process.env.CLIPROXYAPI_FAST;
		try {
			process.env.CLIPROXYAPI_FAST = "true";
			expect(resolveFastDefault({ fast: false })).toBe(true);

			process.env.CLIPROXYAPI_FAST = "0";
			expect(resolveFastDefault({ fast: true })).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.CLIPROXYAPI_FAST;
			else process.env.CLIPROXYAPI_FAST = prev;
		}
	});

	it("throws when CLIPROXYAPI_FAST env var is invalid", () => {
		const prev = process.env.CLIPROXYAPI_FAST;
		try {
			process.env.CLIPROXYAPI_FAST = "invalid-bool";
			expect(() => resolveFastDefault({})).toThrow(/must be one of/);
		} finally {
			if (prev === undefined) delete process.env.CLIPROXYAPI_FAST;
			else process.env.CLIPROXYAPI_FAST = prev;
		}
	});
});

describe("isUnauthorizedModelsError", () => {
	it("identifies 401 ModelsHttpError correctly", () => {
		const err401 = new ModelsHttpError(401, "Unauthorized", "bad key");
		const err500 = new ModelsHttpError(500, "Server Error", "");
		const standardErr = new Error("other");

		expect(isUnauthorizedModelsError(err401)).toBe(true);
		expect(isUnauthorizedModelsError(err500)).toBe(false);
		expect(isUnauthorizedModelsError(standardErr)).toBe(false);
	});
});

describe("resolveApiDriver", () => {
	it("defaults to openai-responses", () => {
		expect(DEFAULT_API_DRIVER).toBe("openai-responses");
		expect(resolveApiDriver()).toBe("openai-responses");
	});

	it("accepts Responses and rejects other legacy protocols", () => {
		expect(resolveApiDriver({ api: "openai-responses" })).toBe("openai-responses");
		expect(() => resolveApiDriver({ api: "openai-codex-responses" })).toThrow(/Unsupported/);
		expect(() => resolveApiDriver({ api: "openai-completions" })).toThrow(/only openai-responses/);
	});

	it("rejects obsolete environment protocol overrides", () => {
		const prev = process.env.CLIPROXYAPI_API_DRIVER;
		try {
			process.env.CLIPROXYAPI_API_DRIVER = "openai-completions";
			expect(() => resolveApiDriver({ api: "openai-responses" })).toThrow(/Remove legacy API overrides/);
		} finally {
			if (prev === undefined) delete process.env.CLIPROXYAPI_API_DRIVER;
			else process.env.CLIPROXYAPI_API_DRIVER = prev;
		}
	});
});

describe("resolveIdentity", () => {
	it("uses defaults when no overrides exist", () => {
		expect(resolveIdentity()).toEqual({
			providerId: DEFAULT_PROVIDER_ID,
			providerName: DEFAULT_PROVIDER_NAME,
		});
		expect(DEFAULT_PROVIDER_ID).toBe("cliproxyapi");
	});

	it("prefers CPA_PROVIDER_ID and CLIPROXYAPI_PROVIDER_ID environment variables", () => {
		const prevCpaId = process.env.CPA_PROVIDER_ID;
		const prevCliproxyId = process.env.CLIPROXYAPI_PROVIDER_ID;
		const prevName = process.env.CPA_PROVIDER_NAME;
		try {
			process.env.CPA_PROVIDER_ID = "cpa-custom";
			process.env.CPA_PROVIDER_NAME = "Custom CPA Name";

			expect(resolveIdentity({ providerId: "file-id", providerName: "file-name" })).toEqual({
				providerId: "cpa-custom",
				providerName: "Custom CPA Name",
			});
		} finally {
			if (prevCpaId === undefined) delete process.env.CPA_PROVIDER_ID;
			else process.env.CPA_PROVIDER_ID = prevCpaId;
			if (prevCliproxyId === undefined) delete process.env.CLIPROXYAPI_PROVIDER_ID;
			else process.env.CLIPROXYAPI_PROVIDER_ID = prevCliproxyId;
			if (prevName === undefined) delete process.env.CPA_PROVIDER_NAME;
			else process.env.CPA_PROVIDER_NAME = prevName;
		}
	});
});

describe("resolveConnection", () => {
	it("propagates malformed configuration instead of silently selecting the default endpoint", () => {
		const dir = tempTestDir();
		writeFileSync(join(dir, CONFIG_FILE_NAME), "invalid JSON");
		expect(() => resolveConnection(dir, "test-key")).toThrow(SyntaxError);
	});

	it("resolves default connection without apiKey", () => {
		const dir = tempTestDir();
		const conn = resolveConnection(dir);
		expect(conn.baseUrlInput).toBe(DEFAULT_BASE_URL);
		expect(conn.inferenceBaseUrl).toBe("http://127.0.0.1:8317/v1");
		expect(conn.apiKey).toBeUndefined();
	});

	it("merges extra apiKey passed at runtime", () => {
		const dir = tempTestDir();
		const conn = resolveConnection(dir, "cli-runtime-key");
		expect(conn.apiKey).toBe("cli-runtime-key");
	});
});

describe("model mapping helpers", () => {
	it("extracts unique reasoning efforts", () => {
		expect(
			extractReasoningEfforts({
				supported_reasoning_levels: [{ effort: "High" }, { effort: "high" }, { effort: "" }],
			}),
		).toEqual(["high"]);

		expect(
			extractReasoningEfforts({
				supported_reasoning_levels: ["Low", "low", "medium"],
			}),
		).toEqual(["low", "medium"]);
	});

	it("builds input modalities and guarantees text support", () => {
		expect(buildInputModalities({ input_modalities: ["image"] })).toEqual(["text", "image"]);
		expect(buildInputModalities({ input_modalities: ["text", "image"] })).toEqual(["text", "image"]);
		expect(buildInputModalities({ supports_image_detail_original: true })).toEqual(["text", "image"]);
		expect(buildInputModalities({})).toEqual(["text"]);
	});

	it("detects fast service tier capability", () => {
		expect(supportsFastServiceTier({ service_tiers: ["priority"] })).toBe(true);
		expect(supportsFastServiceTier({ service_tiers: [] })).toBe(false);
		expect(supportsFastServiceTier({ service_tiers: ["default"] })).toBe(false);
		expect(supportsFastServiceTier({ service_tiers: [{ id: "priority" }] })).toBe(true);
		expect(supportsFastServiceTier({})).toBe(false);
	});

	it("maps CodexClientModel to OpenClawProviderModel", () => {
		const model: CodexClientModel = {
			id: "gpt-4o",
			display_name: "GPT-4o (Omni)",
			context_window: 128000,
			input_modalities: ["text", "image"],
			service_tiers: ["priority"],
		};

		const mapped = toOpenClawModel(model, "cliproxyapi", undefined, true);
		expect(mapped).not.toBeNull();
		expect(mapped?.id).toBe("gpt-4o");
		expect(mapped?.name).toBe("GPT-4o (Omni)");
		expect(mapped?.provider).toBe("cliproxyapi");
		expect(mapped?.api).toBe(OPENCLAW_API_DRIVER);
		expect(mapped?.contextWindow).toBe(128000);
		expect(mapped?.maxTokens).toBe(DEFAULT_MAX_TOKENS);
		expect(mapped?.input).toEqual(["text", "image"]);
		expect(mapped?.params).toEqual({
			service_tier: "priority",
			extra_body: { service_tier: "priority" },
		});
	});

	it("includes models regardless of visibility attribute and annotates category", () => {
		const model: CodexClientModel = {
			id: "gpt-image-2",
			visibility: "hide",
		};
		const mapped = toOpenClawModel(model, "cliproxyapi");
		expect(mapped).not.toBeNull();
		expect(mapped?.id).toBe("gpt-image-2");
		expect(mapped?.name).toBe("gpt-image-2 [Image Gen]");
	});

	it.each([
		"dall-e-3",
		"gpt-image-2",
		"gemini-3.1-flash-image",
		"grok-imagine-video",
	])("does not infer image input support from the generation model name %s", (id) => {
		expect(toOpenClawModel({ id, input_modalities: ["text"] }, "cliproxyapi")?.input).toEqual(["text"]);
		expect(toOpenClawModel({ id }, "cliproxyapi")?.input).toEqual(["text"]);
		expect(toOpenClawModel({ id, input_modalities: ["text", "image"] }, "cliproxyapi")?.input).toEqual([
			"text",
			"image",
		]);
	});

	it("does not use visibility as a capability discriminator", () => {
		for (const visibility of ["list", "hide"]) {
			expect(classifyModel({ slug: "gemini-3.1-flash-image", visibility })).toBe("image");
			expect(toOpenClawModel({ slug: "gemini-3.1-flash-image", visibility }, "cpa")?.name).toContain("[Image Gen]");
		}
	});

	it("classifies models correctly into chat, image, and video", () => {
		expect(classifyModel("gpt-4o")).toBe("chat");
		expect(classifyModel("claude-3-7-sonnet")).toBe("chat");
		expect(classifyModel("deepseek-r1")).toBe("chat");
		expect(classifyModel("gemini-3.1-flash-image")).toBe("image");
		expect(classifyModel("gpt-image-2")).toBe("image");
		expect(classifyModel("grok-imagine-image")).toBe("image");
		expect(classifyModel("dall-e-3")).toBe("image");
		expect(classifyModel("flux-1-dev")).toBe("image");
		expect(classifyModel("grok-imagine-video")).toBe("video");
		expect(classifyModel("grok-imagine-video-1.5-preview")).toBe("video");
		expect(classifyModel("sora-1")).toBe("video");
		expect(classifyModel("veo-2")).toBe("video");
	});
});

describe("pricing & matchModelCost", () => {
	it("returns ZERO_COST when catalog is empty or unmatched", () => {
		const emptyCatalog: ModelsDevCostCatalog = { exact: new Map(), normalized: new Map() };
		expect(matchModelCost("unknown-model", emptyCatalog)).toEqual(ZERO_COST);
	});

	it("matches model cost from catalog and switches in fast mode", () => {
		const catalog: ModelsDevCostCatalog = {
			exact: new Map([
				[
					"gpt-4o",
					[
						{
							providerId: "openai",
							modelId: "gpt-4o",
							standard: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
							fast: { input: 5.0, output: 20, cacheRead: 2.5, cacheWrite: 5.0 },
						},
					],
				],
			]),
			normalized: new Map(),
		};

		const standardCost = matchModelCost("gpt-4o", catalog, false);
		expect(standardCost.input).toBe(2.5);

		const fastCost = matchModelCost("gpt-4o", catalog, true);
		expect(fastCost.input).toBe(5.0);
	});
});

describe("models cache persistence", () => {
	it("saves and reloads cached models", () => {
		const dir = tempTestDir();
		const cache = {
			fetchedAt: 1234567890,
			inferenceBaseUrl: "http://127.0.0.1:8317/v1",
			modelsUrl: "http://127.0.0.1:8317/v1/models?client_version=openclaw",
			fastMode: false,
			fastModelIds: ["gpt-4o"],
			models: [
				{
					id: "gpt-4o",
					name: "GPT-4o",
					provider: "cliproxyapi",
					api: OPENCLAW_API_DRIVER,
					reasoning: false,
					input: ["text", "image"] as Array<"text" | "image">,
					cost: ZERO_COST,
					contextWindow: 128000,
					maxTokens: 16384,
				},
			],
		};

		saveModelsCache(dir, cache);
		const loaded = loadModelsCache(dir, "http://127.0.0.1:8317");
		expect(loaded).toEqual(cache);
	});

	it("returns null if baseUrl changed", () => {
		const dir = tempTestDir();
		saveModelsCache(dir, {
			fetchedAt: 1234567890,
			inferenceBaseUrl: "http://127.0.0.1:8317/v1",
			modelsUrl: "http://127.0.0.1:8317/v1/models?client_version=openclaw",
			fastModelIds: [],
			models: [],
		});

		expect(loadModelsCache(dir, "http://different-host:9999")).toBeNull();
	});
});

describe("context window & limit resolution", () => {
	it("strips reasoning, tier, and preview suffixes for pricing aliases", () => {
		expect(stripReasoningOrTierSuffix("gemini-3.8-flash-high")).toBe("gemini-3.8-flash");
		expect(stripReasoningOrTierSuffix("grok-4.5-medium")).toBe("grok-4.5");
		expect(stripReasoningOrTierSuffix("gemini-3-flash-preview")).toBe("gemini-3-flash");
		expect(stripReasoningOrTierSuffix("claude-3-7-sonnet-latest")).toBe("claude-3-7-sonnet");
		expect(stripReasoningOrTierSuffix("gpt-5.6-luna")).toBe("gpt-5.6-luna");
	});

	it("resolves limits strictly from CPA context_length and max_completion_tokens", () => {
		const model: CodexClientModel = {
			id: "gemini-3.8-flash-high",
			context_length: 1048576,
			max_completion_tokens: 65536,
		};
		const limits = resolveModelLimits(model);
		expect(limits.contextWindow).toBe(1048576);
		expect(limits.maxTokens).toBe(65536);
	});

	it("resolves limits from CPA inputTokenLimit and outputTokenLimit", () => {
		const model: CodexClientModel = {
			id: "home-model",
			inputTokenLimit: 524288,
			outputTokenLimit: 16384,
		};
		const limits = resolveModelLimits(model);
		expect(limits.contextWindow).toBe(524288);
		expect(limits.maxTokens).toBe(16384);
	});

	it("resolves limits from CPA context_window and max_tokens", () => {
		const model: CodexClientModel = {
			id: "custom-model",
			context_window: 256000,
			max_tokens: 32768,
		};
		const limits = resolveModelLimits(model);
		expect(limits.contextWindow).toBe(256000);
		expect(limits.maxTokens).toBe(32768);
	});

	it("falls back to defaults when CPA does not provide context or output limits", () => {
		const model: CodexClientModel = { id: "unknown-model" };
		const limits = resolveModelLimits(model);
		expect(limits.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(limits.maxTokens).toBe(DEFAULT_MAX_TOKENS);
	});

	it("applies CPA native limits in toOpenClawModel", () => {
		const mapped = toOpenClawModel(
			{
				id: "gemini-3.8-flash-high",
				context_length: 1048576,
				max_completion_tokens: 65536,
			},
			"cliproxyapi",
		);
		expect(mapped?.contextWindow).toBe(1048576);
		expect(mapped?.maxTokens).toBe(65536);
	});
});

describe("createDynamicModel", () => {
	it("creates an on-the-fly model with sensible defaults", () => {
		const dynamic = createDynamicModel("o3-mini", "cliproxyapi", "http://127.0.0.1:8317/v1", undefined, true);

		expect(dynamic.id).toBe("o3-mini");
		expect(dynamic.provider).toBe("cliproxyapi");
		expect(dynamic.reasoning).toBe(true);
		expect(dynamic.api).toBe(OPENCLAW_API_DRIVER);
		expect(dynamic.baseUrl).toBe("http://127.0.0.1:8317/v1");
		expect(dynamic.params?.service_tier).toBe("priority");
	});
});

describe("fetchCodexModels", () => {
	it("returns models on 200 JSON array", async () => {
		const mockResponse = [{ id: "model-1", name: "Model 1" }];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => mockResponse,
			}),
		);

		const result = await fetchCodexModels("http://localhost:8317/v1/models");
		expect(result).toEqual(mockResponse);
	});

	it("handles 401 error with ModelsHttpError", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
				text: async () => "invalid api key",
			}),
		);

		await expect(fetchCodexModels("http://localhost:8317/v1/models")).rejects.toThrow(
			/models request failed: 401 Unauthorized/,
		);
	});
});
