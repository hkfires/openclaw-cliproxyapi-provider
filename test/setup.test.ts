import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/core";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfigFile } from "../src/lib.js";
import { createAuthMethod } from "../src/setup-entry.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	vi.unstubAllGlobals();
});
it.each(["cliproxyapi", "cpa"])("returns valid model definitions and an auth profile for %s", async (providerId) => {
	const dir = mkdtempSync(join(tmpdir(), "cpa-auth-"));
	dirs.push(dir);
	const text = vi.fn().mockResolvedValueOnce("http://localhost:8317").mockResolvedValueOnce("secret");
	const ctx = { prompter: { text }, config: {} } as unknown as ProviderAuthContext;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "test" }, { id: "second" }] }))),
	);
	const result = await createAuthMethod(dir, providerId).run(ctx);
	expect(result.profiles[0].credential).toMatchObject({ type: "api_key", provider: providerId, key: "secret" });
	expect(loadConfigFile(dir).apiKey).toBeUndefined();
	expect(result.defaultModel).toBe(`${providerId}/test`);
	const provider = result.configPatch?.models?.providers?.[providerId];
	expect(provider).toMatchObject({ baseUrl: "http://localhost:8317/v1", api: "openai-responses" });
	expect(provider?.models?.map((model) => model.id)).toEqual(["test", "second"]);
	for (const model of provider?.models ?? []) {
		expect(model).not.toHaveProperty("provider");
		expect(model).toMatchObject({
			api: "openai-responses",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}
	expect(text.mock.calls[1][0].sensitive).toBe(true);
});
it("does not save settings when authentication fails", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cpa-auth-"));
	dirs.push(dir);
	const ctx = {
		prompter: { text: vi.fn().mockResolvedValueOnce("http://localhost:8317").mockResolvedValueOnce("bad") },
	} as unknown as ProviderAuthContext;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("", { status: 401 })),
	);
	await expect(createAuthMethod(dir, "cliproxyapi").run(ctx)).rejects.toThrow(/401/);
	expect(loadConfigFile(dir)).toEqual({});
});
