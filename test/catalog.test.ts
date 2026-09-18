import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProviderRegistration } from "../src/index.js";
import { MODELS_CACHE_FILE_NAME, saveConfigFile } from "../src/lib.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	vi.unstubAllGlobals();
});
function fixture() {
	const configDir = mkdtempSync(join(tmpdir(), "cpa-test-"));
	dirs.push(configDir);
	saveConfigFile(configDir, { apiKey: "test-key" });
	const reg = buildProviderRegistration({ configDir });
	const ctx = {
		config: {},
		env: {},
		resolveProviderApiKey: () => ({ apiKey: "test-key" }),
		resolveProviderAuth: () => ({ apiKey: "test-key", source: "profile", mode: "api_key" }),
	} satisfies ProviderCatalogContext;
	return { reg, ctx, configDir };
}
function mockCatalog(payload: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async (url: string) =>
				new Response(JSON.stringify(url.includes("models.dev") ? {} : payload), { status: 200 }),
		),
	);
}
describe("SDK catalog contract", () => {
	it("returns a Responses provider and no fictitious models", async () => {
		const { reg, ctx } = fixture();
		mockCatalog({ data: [{ id: "test", service_tiers: ["priority"] }] });
		const result = await reg.catalog!.run(ctx);
		expect(result && "provider" in result && result.provider.api).toBe("openai-responses");
	});
	it("preserves disk cache on malformed JSON, shape, or rows", async () => {
		const { reg, ctx, configDir } = fixture();
		mockCatalog({ data: [{ id: "test" }] });
		await reg.catalog!.run(ctx);
		const before = readFileSync(join(configDir, MODELS_CACHE_FILE_NAME), "utf8");
		for (const invalid of [{ bad: true }, { data: [null] }]) {
			mockCatalog(invalid);
			const result = await reg.catalog!.run(ctx);
			expect(result && "provider" in result && result.provider.models[0].id).toBe("test");
		}
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not JSON")),
		);
		await reg.catalog!.run(ctx);
		expect(readFileSync(join(configDir, MODELS_CACHE_FILE_NAME), "utf8")).toBe(before);
	});
	it("does not mask rejected credentials with cached models", async () => {
		const { reg, ctx } = fixture();
		mockCatalog({ data: [{ id: "test" }] });
		await reg.catalog!.run(ctx);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("secret reflected", { status: 401 })),
		);
		await expect(reg.catalog!.run(ctx)).rejects.toThrow(/401/);
	});
	it("allows a genuinely empty catalog", async () => {
		const { reg, ctx } = fixture();
		mockCatalog({ data: [] });
		const result = await reg.catalog!.run(ctx);
		expect(result && "provider" in result && result.provider.models).toEqual([]);
	});
});
