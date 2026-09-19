import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as lib from "../src/lib.js";
import { createAuthMethod, resolveExistingApiKey } from "../src/setup-entry.js";
import type { CodexClientModel } from "../src/types.js";

const dirs: string[] = [];
beforeEach(() => {
	vi.stubEnv("CLIPROXYAPI_FAST", undefined);
	vi.stubEnv("CPA_FAST", undefined);
});
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function fixture(
	rows: CodexClientModel[] = [{ id: "test" }, { id: "second" }],
	config: ProviderAuthContext["config"] = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "cpa-auth-"));
	dirs.push(dir);
	const text = vi.fn().mockResolvedValueOnce("http://localhost:8317").mockResolvedValueOnce("test-key");
	const select = vi.fn(async (params: { options: { value: string }[] }) => params.options[0].value);
	const multiselect = vi.fn(async (_params: { options: { value: string }[] }): Promise<string[]> => []);
	const ctx = { prompter: { text, select, multiselect }, config } as unknown as ProviderAuthContext;
	const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: rows })));
	vi.stubGlobal("fetch", fetch);
	return { dir, ctx, text, select, multiselect, fetch };
}

function seedConnection(dir: string) {
	lib.saveConfigFile(dir, { baseUrl: "http://previous.test", apiKey: "previous-key", fast: true });
	lib.saveModelsCache(dir, {
		fetchedAt: 123,
		...lib.resolveEndpoints("http://previous.test"),
		fastModelIds: [],
		models: [],
	});
	return {
		config: readFileSync(join(dir, lib.CONFIG_FILE_NAME), "utf8"),
		cache: readFileSync(join(dir, lib.MODELS_CACHE_FILE_NAME), "utf8"),
	};
}

it.each(["cliproxyapi", "cpa"])("authenticates %s without injecting a static provider catalog", async (providerId) => {
	const { dir, ctx, text, fetch } = fixture();
	const result = await createAuthMethod(dir, providerId).run(ctx);
	expect(result.profiles[0].credential).toEqual({ type: "api_key", provider: providerId, key: "test-key" });
	expect(lib.loadConfigFile(dir)).toEqual({ baseUrl: "http://localhost:8317", api: "openai-responses" });
	expect(result.defaultModel).toBeUndefined();
	expect(result.configPatch?.models).toBeUndefined();
	expect(result.configPatch?.agents?.defaults).toEqual({
		model: { primary: `${providerId}/test`, fallbacks: [] },
	});
	expect(result.configPatch?.agents?.defaults?.models).toBeUndefined();
	const cached = lib.loadModelsCache(dir);
	expect(cached?.models.map((model) => model.id)).toEqual(["test", "second"]);
	expect(cached?.models.every((model) => model.provider === providerId)).toBe(true);
	expect(readFileSync(join(dir, lib.MODELS_CACHE_FILE_NAME), "utf8")).not.toContain("test-key");
	expect(text.mock.calls[1][0].sensitive).toBe(true);
	expect(fetch.mock.calls[0][0]).toBe("http://localhost:8317/v1/models?client_version=openclaw");
});

it("adds selected chat models only when the user already has a model allowlist", async () => {
	const config: ProviderAuthContext["config"] = {
		agents: { defaults: { models: { "openai/gpt-4o": { alias: "vision" } } } },
	};
	const { dir, ctx, multiselect } = fixture(undefined, config);
	multiselect.mockResolvedValueOnce(["second"]);
	const result = await createAuthMethod(dir, "cliproxyapi").run(ctx);
	expect(result.configPatch?.agents?.defaults?.models).toEqual({
		"cliproxyapi/test": {},
		"cliproxyapi/second": {},
	});
	expect(ctx.config).toEqual(config);
});

it.each([
	"cliproxyapi",
	"cpa",
	"custom-cpa",
])("synchronizes existing routes when reauthenticating %s", async (providerId) => {
	const oldProvider = {
		baseUrl: "http://previous.test/v1",
		api: "openai-responses" as const,
		models: [{ id: "manual-model", name: "Custom name", contextWindow: 8192 }],
		headers: { "X-Custom": "keep" },
	};
	const config: ProviderAuthContext["config"] = {
		models: {
			mode: "merge",
			providers: {
				cliproxyapi: structuredClone(oldProvider),
				cpa: structuredClone(oldProvider),
				"custom-cpa": structuredClone(oldProvider),
				unrelated: structuredClone(oldProvider),
			},
		},
	};
	const original = structuredClone(config);
	const { dir, ctx } = fixture(undefined, config);
	seedConnection(dir);
	const result = await createAuthMethod(dir, providerId).run(ctx);
	const providers = result.configPatch?.models?.providers;
	const expectedIds = providerId === "custom-cpa" ? [providerId] : ["cliproxyapi", "cpa"];
	expect(Object.keys(providers ?? {})).toEqual(expectedIds);
	for (const id of expectedIds) {
		expect(providers?.[id]).toEqual({ ...oldProvider, baseUrl: "http://localhost:8317/v1" });
	}
	expect(result.configPatch?.models?.mode).toBeUndefined();
	expect(ctx.config).toEqual(original);
	expect(lib.loadConfigFile(dir)).toEqual({ baseUrl: "http://localhost:8317", api: "openai-responses", fast: true });
});

it("updates stale limits for existing provider models matching newly discovered models", async () => {
	const oldProvider = {
		baseUrl: "http://previous.test/v1",
		api: "openai-responses" as const,
		models: [
			{ id: "gemini-3.7-flash-high", name: "Gemini", contextWindow: 128000, maxTokens: 16384 },
			{ id: "manual-model", name: "Custom", contextWindow: 8192 },
		],
	};
	const config: ProviderAuthContext["config"] = {
		models: {
			providers: {
				cliproxyapi: structuredClone(oldProvider),
			},
		},
	};
	const { dir, ctx } = fixture(
		[{ id: "gemini-3.7-flash-high", context_length: 1048576, max_completion_tokens: 65536 }],
		config,
	);
	seedConnection(dir);
	const result = await createAuthMethod(dir, "cliproxyapi").run(ctx);
	const synced = result.configPatch?.models?.providers?.cliproxyapi?.models;
	expect(synced).toEqual([
		{ id: "gemini-3.7-flash-high", name: "Gemini", contextWindow: 1048576, maxTokens: 65536 },
		{ id: "manual-model", name: "Custom", contextWindow: 8192 },
	]);
});

it("separates image selection and preserves existing vision/media settings when skipped", async () => {
	const config: ProviderAuthContext["config"] = {
		agents: {
			defaults: {
				imageModel: { primary: "openai/gpt-4o", fallbacks: ["other/vision"], timeoutMs: 10000 },
				mediaModels: {
					image: { primary: "openai/gpt-image-2" },
					video: { primary: "other/video" },
				},
			},
		},
	};
	const before = structuredClone(config);
	const { dir, ctx, select, multiselect } = fixture(
		[
			{ id: "gpt-image-2", visibility: "hide" },
			{ id: "gpt-4o" },
			{ id: "gpt-5.6-sol" },
			{ id: "gemini-3.1-flash-image", visibility: "list" },
			{ id: "grok-imagine-video", visibility: "hide" },
		],
		config,
	);
	select.mockResolvedValueOnce("gpt-5.6-sol");
	multiselect.mockResolvedValueOnce(["gpt-4o"]);
	const result = await createAuthMethod(dir, "cliproxyapi").run(ctx);
	expect(select).toHaveBeenCalledTimes(2);
	expect(select.mock.calls[1][0].options.map((option) => option.value)).toEqual([
		"",
		"gpt-image-2",
		"gemini-3.1-flash-image",
	]);
	expect(select.mock.calls[0][0].options.map((option) => option.value)).toEqual(["gpt-4o", "gpt-5.6-sol"]);
	expect(multiselect).toHaveBeenCalledTimes(1);
	expect(multiselect.mock.calls[0][0].options.map((option: { value: string }) => option.value)).toEqual(["gpt-4o"]);
	expect(result.configPatch?.agents?.defaults).toEqual({
		model: { primary: "cliproxyapi/gpt-5.6-sol", fallbacks: ["cliproxyapi/gpt-4o"] },
	});
	expect(result.notes).toHaveLength(1);
	expect(ctx.config).toEqual(before);
	// Keep discovery complete; retaining a catalog row is not a generation route.
	expect(lib.loadModelsCache(dir)?.models).toHaveLength(5);
});

it.each([
	{ rows: [] },
	{ rows: [{ id: "gpt-image-2" }, { id: "grok-imagine-video" }] },
	{ rows: [{ id: "imagen-4.0-generate-001", visibility: "list" }] },
])("omits all chat defaults for empty or media-only catalogs: $rows", async ({ rows }) => {
	const { dir, ctx, select, multiselect } = fixture(rows, {
		agents: { defaults: { model: { primary: "other/chat", fallbacks: ["other/backup"] } } },
	});
	const before = structuredClone(ctx.config);
	const result = await createAuthMethod(dir, "cliproxyapi").run(ctx);
	expect(result.defaultModel).toBeUndefined();
	expect(result.configPatch).toBeUndefined();
	expect(select).toHaveBeenCalledTimes(rows.some((m) => lib.classifyModel(m) === "image") ? 1 : 0);
	expect(multiselect).not.toHaveBeenCalled();
	expect(ctx.config).toEqual(before);
	expect(lib.loadModelsCache(dir)?.models).toHaveLength(rows.length);
});

it.each([
	"cliproxyapi",
	"cpa",
])("writes only explicitly selected image models to mediaModels.image for %s", async (providerId) => {
	const config: ProviderAuthContext["config"] = {
		agents: {
			defaults: {
				imageModel: { primary: "other/vision" },
				mediaModels: {
					image: { primary: "other/image", fallbacks: ["other/backup"] },
					video: { primary: "other/video" },
				},
			},
		},
	};
	const { dir, ctx, select, multiselect } = fixture(
		[
			{ id: "gpt-image-2", visibility: "hide" },
			{ id: "gemini-3.1-flash-image", visibility: "list" },
			{ id: "grok-imagine-image" },
			{ id: "grok-imagine-video" },
		],
		config,
	);
	select.mockResolvedValueOnce("gpt-image-2");
	multiselect.mockResolvedValueOnce(["gemini-3.1-flash-image"]);
	const result = await createAuthMethod(dir, providerId).run(ctx);
	expect(result.defaultModel).toBeUndefined();
	expect(result.configPatch).toEqual({
		agents: {
			defaults: {
				mediaModels: {
					image: {
						primary: `${providerId}/gpt-image-2`,
						fallbacks: [`${providerId}/gemini-3.1-flash-image`],
					},
				},
			},
		},
	});
	expect(ctx.config).toEqual(config);
	expect(select).toHaveBeenCalledOnce();
	expect(multiselect.mock.calls[0][0].options.map((m) => m.value)).toEqual([
		"gemini-3.1-flash-image",
		"grok-imagine-image",
	]);
});

it("writes an empty image fallback list when none were selected", async () => {
	const { dir, ctx, select } = fixture([{ id: "gpt-image-2" }]);
	select.mockResolvedValueOnce("gpt-image-2");
	const result = await createAuthMethod(dir, "cpa").run(ctx);
	expect(result.configPatch?.agents?.defaults?.mediaModels?.image).toEqual({
		primary: "cpa/gpt-image-2",
		fallbacks: [],
	});
});

it.each(["image", "image-fallback"])("does not persist settings if the %s prompt is cancelled", async (stage) => {
	const { dir, ctx, select, multiselect } = fixture([{ id: "gpt-image-2" }, { id: "grok-imagine-image" }]);
	const before = seedConnection(dir);
	const error = Object.assign(new Error("cancelled"), { code: "TEST_CANCELLED" });
	if (stage === "image") select.mockRejectedValueOnce(error);
	else {
		select.mockResolvedValueOnce("gpt-image-2");
		multiselect.mockRejectedValueOnce(error);
	}
	await expect(createAuthMethod(dir, "cpa").run(ctx)).rejects.toBe(error);
	expect(readFileSync(join(dir, lib.CONFIG_FILE_NAME), "utf8")).toBe(before.config);
	expect(readFileSync(join(dir, lib.MODELS_CACHE_FILE_NAME), "utf8")).toBe(before.cache);
});

it.each(["image", "image-fallback"])("rejects invalid %s selections", async (stage) => {
	const { dir, ctx, select, multiselect } = fixture([{ id: "gpt-image-2" }, { id: "grok-imagine-image" }]);
	const before = seedConnection(dir);
	select.mockResolvedValueOnce(stage === "image" ? "gpt-4o" : "gpt-image-2");
	multiselect.mockResolvedValueOnce(["grok-imagine-video"]);
	await expect(createAuthMethod(dir, "cpa").run(ctx)).rejects.toMatchObject({
		code: stage === "image" ? "INVALID_IMAGE_MODEL" : "INVALID_IMAGE_FALLBACK",
	});
	expect(readFileSync(join(dir, lib.CONFIG_FILE_NAME), "utf8")).toBe(before.config);
	expect(readFileSync(join(dir, lib.MODELS_CACHE_FILE_NAME), "utf8")).toBe(before.cache);
});

it("configures vision models when available and selected", async () => {
	const { dir, ctx, select, multiselect } = fixture([
		{ id: "chat-text" },
		{ id: "vision-1", input_modalities: ["text", "image"] },
		{ id: "vision-2", input_modalities: ["image"] },
		{ id: "flux", visibility: "hide" },
	]);
	// 1: chat primary -> "chat-text"
	select.mockResolvedValueOnce("chat-text");
	// 1: chat fallback -> []
	multiselect.mockResolvedValueOnce([]);
	// 2: vision primary -> "vision-1"
	select.mockResolvedValueOnce("vision-1");
	// 2: vision fallback -> ["vision-2"]
	multiselect.mockResolvedValueOnce(["vision-2"]);
	// 3: image gen primary -> "" (skip)
	select.mockResolvedValueOnce("");

	const result = await createAuthMethod(dir, "cliproxyapi").run(ctx);
	expect(result.configPatch?.agents?.defaults?.imageModel).toEqual({
		primary: "cliproxyapi/vision-1",
		fallbacks: ["cliproxyapi/vision-2"],
	});
	expect(result.configPatch?.agents?.defaults?.model).toEqual({
		primary: "cliproxyapi/chat-text",
		fallbacks: [],
	});
	expect(result.configPatch?.agents?.defaults?.mediaModels).toBeUndefined();
});

it("merges vision models into existing allowlist", async () => {
	const config: ProviderAuthContext["config"] = {
		agents: { defaults: { models: { "openai/gpt-4o": { alias: "vision" } } } },
	};
	const { dir, ctx, select, multiselect } = fixture(
		[{ id: "chat-text" }, { id: "vision-1", input_modalities: ["text", "image"] }],
		config,
	);
	select.mockResolvedValueOnce("chat-text");
	multiselect.mockResolvedValueOnce([]);
	select.mockResolvedValueOnce("vision-1");
	multiselect.mockResolvedValueOnce([]);

	const result = await createAuthMethod(dir, "cliproxyapi").run(ctx);
	expect(result.configPatch?.agents?.defaults?.models).toEqual({
		"cliproxyapi/chat-text": {},
		"cliproxyapi/vision-1": {},
	});
});

it.each(["vision", "vision-fallback"])("rejects invalid %s selections with stable error codes", async (stage) => {
	const { dir, ctx, select, multiselect } = fixture([
		{ id: "chat-text" },
		{ id: "vision-1", input_modalities: ["text", "image"] },
		{ id: "vision-2", input_modalities: ["text", "image"] },
	]);
	const before = seedConnection(dir);
	select.mockResolvedValueOnce("chat-text");
	multiselect.mockResolvedValueOnce([]);
	if (stage === "vision") {
		select.mockResolvedValueOnce("non-existent");
	} else {
		select.mockResolvedValueOnce("vision-1");
		multiselect.mockResolvedValueOnce(["non-existent"]);
	}
	await expect(createAuthMethod(dir, "cliproxyapi").run(ctx)).rejects.toMatchObject({
		code: stage === "vision" ? "INVALID_VISION_MODEL" : "INVALID_VISION_FALLBACK",
	});
	expect(readFileSync(join(dir, lib.CONFIG_FILE_NAME), "utf8")).toBe(before.config);
	expect(readFileSync(join(dir, lib.MODELS_CACHE_FILE_NAME), "utf8")).toBe(before.cache);
});

it.each([
	"vision",
	"vision-fallback",
])("preserves connection and cache when %s selection is cancelled", async (stage) => {
	const { dir, ctx, select, multiselect } = fixture([
		{ id: "chat-text" },
		{ id: "vision-1", input_modalities: ["text", "image"] },
		{ id: "vision-2", input_modalities: ["text", "image"] },
	]);
	const before = seedConnection(dir);
	const cancelled = Object.assign(new Error("Cancelled"), { code: "TEST_CANCELLED" });
	select.mockResolvedValueOnce("chat-text");
	multiselect.mockResolvedValueOnce([]);
	if (stage === "vision") {
		select.mockRejectedValueOnce(cancelled);
	} else {
		select.mockResolvedValueOnce("vision-1");
		multiselect.mockRejectedValueOnce(cancelled);
	}
	await expect(createAuthMethod(dir, "cliproxyapi").run(ctx)).rejects.toBe(cancelled);
	expect(readFileSync(join(dir, lib.CONFIG_FILE_NAME), "utf8")).toBe(before.config);
	expect(readFileSync(join(dir, lib.MODELS_CACHE_FILE_NAME), "utf8")).toBe(before.cache);
});

it("updates a legacy URL even when the catalog is empty, without changing the default model", async () => {
	const { dir, ctx } = fixture([], {
		models: { providers: { cpa: { baseUrl: "http://previous.test/v1", models: [] } } },
	});
	const result = await createAuthMethod(dir, "cpa").run(ctx);
	expect(result.defaultModel).toBeUndefined();
	expect(result.configPatch).toEqual({
		models: { providers: { cpa: { baseUrl: "http://localhost:8317/v1", api: "openai-responses", models: [] } } },
	});
});

it.each([
	"primary",
	"fallback",
	"signal",
])("preserves connection and cache when %s selection is cancelled", async (stage) => {
	const { dir, ctx, select, multiselect } = fixture();
	const before = seedConnection(dir);
	const cancelled = Object.assign(new Error("Cancelled"), { code: "TEST_CANCELLED" });
	if (stage === "primary") select.mockRejectedValueOnce(cancelled);
	if (stage === "fallback") multiselect.mockRejectedValueOnce(cancelled);
	if (stage === "signal") {
		const controller = new AbortController();
		ctx.signal = controller.signal;
		multiselect.mockImplementationOnce(async () => {
			controller.abort(cancelled);
			return [];
		});
	}
	await expect(createAuthMethod(dir, "cliproxyapi").run(ctx)).rejects.toBe(cancelled);
	expect(readFileSync(join(dir, lib.CONFIG_FILE_NAME), "utf8")).toBe(before.config);
	expect(readFileSync(join(dir, lib.MODELS_CACHE_FILE_NAME), "utf8")).toBe(before.cache);
});

it.each([
	{ stage: "primary", code: "INVALID_PRIMARY_MODEL" },
	{ stage: "fallback", code: "INVALID_FALLBACK_MODEL" },
])("rejects invalid $stage selections with stable codes and no persistence", async ({ stage, code }) => {
	const { dir, ctx, select, multiselect } = fixture();
	const before = seedConnection(dir);
	if (stage === "primary") select.mockResolvedValueOnce("gpt-image-2");
	else multiselect.mockResolvedValueOnce(["grok-imagine-video"]);
	await expect(createAuthMethod(dir, "cliproxyapi").run(ctx)).rejects.toMatchObject({ code });
	expect(readFileSync(join(dir, lib.CONFIG_FILE_NAME), "utf8")).toBe(before.config);
	expect(readFileSync(join(dir, lib.MODELS_CACHE_FILE_NAME), "utf8")).toBe(before.cache);
});

it("propagates cache I/O errors before changing the connection or clearing its credential", async () => {
	const { dir, ctx } = fixture();
	const before = seedConnection(dir);
	const denied = Object.assign(new Error("Denied"), { code: "EACCES" });
	vi.spyOn(lib, "saveModelsCache").mockImplementationOnce(() => {
		throw denied;
	});
	await expect(createAuthMethod(dir, "cliproxyapi").run(ctx)).rejects.toBe(denied);
	expect(readFileSync(join(dir, lib.CONFIG_FILE_NAME), "utf8")).toBe(before.config);
	expect(readFileSync(join(dir, lib.MODELS_CACHE_FILE_NAME), "utf8")).toBe(before.cache);
});

it("fails on an actual unwritable cache target without overwriting connection settings", async () => {
	const { dir, ctx } = fixture();
	lib.saveConfigFile(dir, { baseUrl: "http://previous.test", apiKey: "previous-key" });
	const before = readFileSync(join(dir, lib.CONFIG_FILE_NAME), "utf8");
	mkdirSync(join(dir, lib.MODELS_CACHE_FILE_NAME));
	await expect(createAuthMethod(dir, "cliproxyapi").run(ctx)).rejects.toMatchObject({
		code: expect.stringMatching(/^(EISDIR|EPERM|EACCES)$/),
	});
	expect(readFileSync(join(dir, lib.CONFIG_FILE_NAME), "utf8")).toBe(before);
});

it("propagates connection-config write failures instead of returning successful auth", async () => {
	const { dir, ctx } = fixture();
	const denied = Object.assign(new Error("Denied"), { code: "EACCES" });
	vi.spyOn(lib, "saveConfigFile").mockImplementationOnce(() => {
		throw denied;
	});
	await expect(createAuthMethod(dir, "cliproxyapi").run(ctx)).rejects.toBe(denied);
});

it("fails loudly on malformed JSON without touching saved settings", async () => {
	const { dir, ctx, fetch } = fixture();
	const before = seedConnection(dir);
	fetch.mockResolvedValueOnce(new Response("not json"));
	await expect(createAuthMethod(dir, "cliproxyapi").run(ctx)).rejects.toBeInstanceOf(SyntaxError);
	expect(readFileSync(join(dir, lib.CONFIG_FILE_NAME), "utf8")).toBe(before.config);
	expect(readFileSync(join(dir, lib.MODELS_CACHE_FILE_NAME), "utf8")).toBe(before.cache);
});

it("does not silently replace invalid connection JSON", async () => {
	const { dir, ctx, fetch } = fixture();
	writeFileSync(join(dir, lib.CONFIG_FILE_NAME), "not json");
	await expect(createAuthMethod(dir, "cliproxyapi").run(ctx)).rejects.toBeInstanceOf(SyntaxError);
	expect(fetch).not.toHaveBeenCalled();
	expect(readFileSync(join(dir, lib.CONFIG_FILE_NAME), "utf8")).toBe("not json");
});

it("preserves connection and cache when authentication fails", async () => {
	const { dir, ctx, fetch } = fixture();
	const before = seedConnection(dir);
	fetch.mockResolvedValueOnce(new Response("", { status: 401 }));
	await expect(createAuthMethod(dir, "cliproxyapi").run(ctx)).rejects.toMatchObject({
		name: "ModelsHttpError",
		status: 401,
	});
	expect(readFileSync(join(dir, lib.CONFIG_FILE_NAME), "utf8")).toBe(before.config);
	expect(readFileSync(join(dir, lib.MODELS_CACHE_FILE_NAME), "utf8")).toBe(before.cache);
});

it("skips API key prompt when already configured in config file and user presses Enter", async () => {
	const { dir, ctx, text, fetch } = fixture();
	seedConnection(dir);
	text.mockReset();
	text.mockResolvedValueOnce("http://localhost:8317").mockResolvedValueOnce("");
	const result = await createAuthMethod(dir, "cliproxyapi").run(ctx);
	expect(result.profiles[0].credential).toEqual({
		type: "api_key",
		provider: "cliproxyapi",
		key: "previous-key",
	});
	expect(text.mock.calls[1][0].message).toContain("press Enter to keep existing");
	expect(text.mock.calls[1][0].validate("")).toBeUndefined();
	expect(text.mock.calls[1][0].validate("   ")).toBeUndefined();
	expect(fetch.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer previous-key" }));
});

it("allows entering a new API key even when an existing key is configured", async () => {
	const { dir, ctx, text, fetch } = fixture();
	seedConnection(dir);
	text.mockReset();
	text.mockResolvedValueOnce("http://localhost:8317").mockResolvedValueOnce("new-custom-key");
	const result = await createAuthMethod(dir, "cliproxyapi").run(ctx);
	expect(result.profiles[0].credential).toEqual({
		type: "api_key",
		provider: "cliproxyapi",
		key: "new-custom-key",
	});
	expect(fetch.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer new-custom-key" }));
});

it("skips API key prompt when configured in environment variables", async () => {
	vi.stubEnv("CLIPROXYAPI_API_KEY", "env-key");
	const { dir, ctx, text, fetch } = fixture();
	text.mockReset();
	text.mockResolvedValueOnce("http://localhost:8317").mockResolvedValueOnce("");
	const result = await createAuthMethod(dir, "cliproxyapi").run(ctx);
	expect(result.profiles[0].credential).toEqual({
		type: "api_key",
		provider: "cliproxyapi",
		key: "env-key",
	});
	expect(text.mock.calls[1][0].message).toContain("press Enter to keep existing");
	expect(fetch.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer env-key" }));
});

it("skips API key prompt when configured in models.providers", async () => {
	const config: ProviderAuthContext["config"] = {
		models: {
			providers: {
				cliproxyapi: {
					baseUrl: "http://127.0.0.1:8317/v1",
					api: "openai-responses",
					apiKey: "provider-config-key",
					models: [],
				},
			},
		},
	};
	const { dir, ctx, text } = fixture(undefined, config);
	text.mockReset();
	text.mockResolvedValueOnce("http://localhost:8317").mockResolvedValueOnce("");
	const result = await createAuthMethod(dir, "cliproxyapi").run(ctx);
	expect(result.profiles[0].credential).toEqual({
		type: "api_key",
		provider: "cliproxyapi",
		key: "provider-config-key",
	});
});

it("requires API key when not configured and rejects empty input", async () => {
	const { dir, ctx, text } = fixture();
	text.mockReset();
	text.mockResolvedValueOnce("http://localhost:8317").mockResolvedValueOnce("");
	const authMethod = createAuthMethod(dir, "cliproxyapi");
	await expect(authMethod.run(ctx)).rejects.toThrow("API Key is required");
	expect(text.mock.calls[1][0].message).toBe("CLIProxyAPI API Key");
	expect(text.mock.calls[1][0].validate("")).toBe("API Key is required");
	expect(text.mock.calls[1][0].validate("   ")).toBe("API Key is required");
});

describe("resolveExistingApiKey", () => {
	it("resolves from config file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-test-"));
		dirs.push(dir);
		lib.saveConfigFile(dir, { apiKey: "from-file" });
		expect(await resolveExistingApiKey(dir, "cliproxyapi")).toBe("from-file");
	});

	it("resolves from environment variables", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-test-"));
		dirs.push(dir);
		vi.stubEnv("CPA_API_KEY", "from-cpa-env");
		expect(await resolveExistingApiKey(dir, "cliproxyapi")).toBe("from-cpa-env");
	});

	it("resolves from ctx.opts token if matching provider", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-test-"));
		dirs.push(dir);
		expect(
			await resolveExistingApiKey(dir, "cliproxyapi", {
				opts: { token: "token-123", tokenProvider: "cliproxyapi" },
			}),
		).toBe("token-123");
		expect(
			await resolveExistingApiKey(dir, "cliproxyapi", {
				opts: { token: "token-456", tokenProvider: "cpa" },
			}),
		).toBe("token-456");
		expect(
			await resolveExistingApiKey(dir, "cliproxyapi", {
				opts: { token: "token-789", tokenProvider: "other-provider" },
			}),
		).toBeUndefined();
	});

	it("resolves from ctx.config models.providers alias", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-test-"));
		dirs.push(dir);
		const ctx = {
			config: {
				models: {
					providers: {
						cpa: {
							baseUrl: "http://127.0.0.1:8317/v1",
							api: "openai-responses" as const,
							apiKey: "from-alias",
							models: [],
						},
					},
				},
			},
		};
		expect(await resolveExistingApiKey(dir, "cliproxyapi", ctx)).toBe("from-alias");
	});
});
