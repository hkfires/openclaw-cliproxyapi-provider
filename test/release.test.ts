import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi, ProviderCatalogContext, ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/core";
import { afterEach, expect, it, vi } from "vitest";
import { buildProviderRegistration } from "../src/index.js";
import { CONFIG_FILE_NAME, resolveEndpoints, saveConfigFile } from "../src/lib.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
});
function directory() {
	const dir = mkdtempSync(join(tmpdir(), "cpa-release-"));
	dirs.push(dir);
	return dir;
}
it("uses discovery secrets for HTTP and retains safe host markers in catalog", async () => {
	const dir = directory();
	const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "test" }] })));
	vi.stubGlobal("fetch", fetchMock);
	const ctx = {
		config: {},
		env: {},
		resolveProviderApiKey: (id: string) =>
			id === "cpa" ? { apiKey: undefined } : { apiKey: "ENV_MARKER", discoveryApiKey: "real-secret" },
		resolveProviderAuth: () => ({ apiKey: undefined, source: "none", mode: "none" }),
	} satisfies ProviderCatalogContext;
	const reg = buildProviderRegistration({ configDir: dir, providerId: "cpa" });
	const result = await reg.catalog!.run(ctx);
	expect(result && "provider" in result && result.provider.apiKey).toBe("ENV_MARKER");
	const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
	expect(calls.find(([url]) => url.includes("/v1/models"))?.[1].headers).toMatchObject({
		Authorization: "Bearer real-secret",
	});
});
it("injects priority through the real stream hook only for eligible models", async () => {
	const dir = directory();
	saveConfigFile(dir, { apiKey: "test", fast: true });
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "fast", service_tiers: ["priority"] },
							{ id: "normal", service_tiers: ["default"] },
						],
					}),
				),
		),
	);
	const reg = buildProviderRegistration({ configDir: dir });
	const ctx = {
		config: {},
		env: {},
		resolveProviderApiKey: () => ({ apiKey: "test" }),
		resolveProviderAuth: () => ({ apiKey: "test", source: "profile", mode: "api_key" }),
	} satisfies ProviderCatalogContext;
	await reg.catalog!.run(ctx);
	let options: any;
	const stream = vi.fn((_m, _c, o) => {
		options = o;
		return {};
	});
	const wrap = reg.wrapStreamFn!;
	expect(wrap({ modelId: "normal", streamFn: stream } as unknown as ProviderWrapStreamFnContext)).toBe(stream);
	const wrapped = wrap({ modelId: "fast", streamFn: stream } as unknown as ProviderWrapStreamFnContext)!;
	wrapped({} as Parameters<typeof wrapped>[0], {} as Parameters<typeof wrapped>[1], {
		onPayload: () => ({ model: "fast", custom: 1 }),
	});
	expect(await options.onPayload({}, {})).toEqual({ model: "fast", custom: 1, service_tier: "priority" });
});
it("preserves reverse-proxy prefixes and restricts stored config permissions", () => {
	expect(resolveEndpoints("https://example.test/proxy/v1").modelsUrl).toBe(
		"https://example.test/proxy/v1/models?client_version=openclaw",
	);
	const dir = directory();
	saveConfigFile(dir, { apiKey: "secret" });
	expect(JSON.parse(readFileSync(join(dir, CONFIG_FILE_NAME), "utf8")).apiKey).toBe("secret");
	if (process.platform !== "win32") expect(statSync(join(dir, CONFIG_FILE_NAME)).mode & 0o777).toBe(0o600);
});
// Compile this assignment against the installed host, not a local SDK imitation.
type HostProvider = Parameters<OpenClawPluginApi["registerProvider"]>[0];
const contract: (options?: Parameters<typeof buildProviderRegistration>[0]) => HostProvider = buildProviderRegistration;
void contract;
