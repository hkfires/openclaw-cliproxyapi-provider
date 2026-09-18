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
it("uses the host auth.run and returns a credential profile without saving the key in plugin config", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cpa-auth-"));
	dirs.push(dir);
	const text = vi.fn().mockResolvedValueOnce("http://localhost:8317").mockResolvedValueOnce("secret");
	const ctx = { prompter: { text }, config: {} } as unknown as ProviderAuthContext;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "test" }] }))),
	);
	const result = await createAuthMethod(dir, "cliproxyapi").run(ctx);
	expect(result.profiles[0].credential).toMatchObject({ type: "api_key", provider: "cliproxyapi", key: "secret" });
	expect(loadConfigFile(dir).apiKey).toBeUndefined();
	expect(result.defaultModel).toBe("cliproxyapi/test");
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
