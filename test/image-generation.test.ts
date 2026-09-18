import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/agent-runtime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildImageGenerationProvider, IMAGE_MAX_BYTES, ImageGenerationError } from "../src/image-generation.js";
import { saveConfigFile } from "../src/lib.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: vi.fn() }));
vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({ resolveApiKeyForProvider: vi.fn() }));
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({ isProviderApiKeyConfigured: vi.fn() }));

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=",
	"base64",
);
const dirs: string[] = [];
const fetchGuard = vi.mocked(fetchWithSsrFGuard);
const resolveAuth = vi.mocked(resolveApiKeyForProvider);
const configured = vi.mocked(isProviderApiKeyConfigured);
const release = vi.fn(async () => {});

beforeEach(() => {
	vi.resetAllMocks();
	for (const key of [
		"CLIPROXYAPI_BASE_URL",
		"CPA_BASE_URL",
		"CLIPROXYAPI_API_KEY",
		"CPA_API_KEY",
		"CLIPROXYAPI_API",
		"CPA_API",
		"CLIPROXYAPI_API_DRIVER",
		"CPA_API_DRIVER",
	])
		vi.stubEnv(key, undefined);
	fetchGuard.mockImplementation(async ({ url }) => ({
		response: new Response(
			JSON.stringify({ data: [{ b64_json: png.toString("base64"), revised_prompt: "revised" }] }),
		),
		release,
		finalUrl: url,
	}));
	resolveAuth.mockResolvedValue({ apiKey: "profile-key", mode: "api-key", source: "profile" });
	configured.mockReturnValue(true);
});
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function fixture(providerId = "cliproxyapi", withKey = true) {
	const dir = mkdtempSync(join(tmpdir(), "cpa-images-"));
	dirs.push(dir);
	saveConfigFile(dir, { baseUrl: "https://cpa.example/proxy/v1", ...(withKey ? { apiKey: "file-key" } : {}) });
	const provider = buildImageGenerationProvider(dir, providerId);
	const req = { provider: providerId, model: "gpt-image-2", prompt: "draw a red circle", cfg: {} };
	return { provider, req, dir };
}

it.each(["cliproxyapi", "cpa"])("generates images using %s and retains proxy prefixes", async (id) => {
	const { provider, req } = fixture(id);
	const result = await provider.generateImage({ ...req, size: "1024x1024" });
	const call = fetchGuard.mock.calls[0][0];
	expect(call.url).toBe("https://cpa.example/proxy/v1/images/generations");
	expect(call.maxRedirects).toBe(0);
	expect(call.signal).toBeInstanceOf(AbortSignal);
	expect(new Headers(call.init?.headers).get("Authorization")).toBe("Bearer file-key");
	expect(JSON.parse(call.init?.body as string)).toEqual({
		model: "gpt-image-2",
		prompt: req.prompt,
		size: "1024x1024",
		n: 1,
		response_format: "b64_json",
		stream: false,
	});
	expect(result.images[0]).toMatchObject({ buffer: png, mimeType: "image/png", revisedPrompt: "revised" });
	expect(result.model).toBe(req.model);
	expect(release).toHaveBeenCalledOnce();
	expect(resolveAuth).not.toHaveBeenCalled();
});

it("uses multipart edits for a reference image", async () => {
	const { provider, req } = fixture();
	await provider.generateImage({ ...req, inputImages: [{ buffer: png, mimeType: "image/png" }] });
	const call = fetchGuard.mock.calls[0][0];
	expect(call.url).toBe("https://cpa.example/proxy/v1/images/edits");
	expect(new Headers(call.init?.headers).has("Content-Type")).toBe(false);
	const form = call.init?.body as FormData;
	expect(form.get("model")).toBe(req.model);
	expect(form.get("prompt")).toBe(req.prompt);
	expect(form.get("stream")).toBe("false");
	expect(form.get("response_format")).toBe("b64_json");
	const image = form.get("image") as File;
	expect(image.type).toBe("image/png");
	expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
});

it("prefers environment connection/auth and otherwise resolves the selected agent's host credentials", async () => {
	const { provider, req } = fixture("cpa", false);
	const authStore = { version: 1, profiles: {} };
	await provider.generateImage({ ...req, agentDir: "/test/agent", authStore });
	expect(resolveAuth).toHaveBeenCalledWith({
		provider: "cpa",
		cfg: {},
		agentDir: "/test/agent",
		store: authStore,
		secretSentinels: false,
	});
	expect(new Headers(fetchGuard.mock.calls[0][0].init?.headers).get("Authorization")).toBe("Bearer profile-key");
	vi.stubEnv("CLIPROXYAPI_BASE_URL", "https://override.example");
	vi.stubEnv("CLIPROXYAPI_API_KEY", "env-key");
	await provider.generateImage(req);
	expect(fetchGuard.mock.calls[1][0].url).toBe("https://override.example/v1/images/generations");
	expect(new Headers(fetchGuard.mock.calls[1][0].init?.headers).get("Authorization")).toBe("Bearer env-key");
	expect(resolveAuth).toHaveBeenCalledOnce();
});

it("resolves alias-specific credentials before canonical credentials", async () => {
	const { dir } = fixture("cliproxyapi", false);
	const provider = buildImageGenerationProvider(dir, "cliproxyapi", ["cpa"]);
	await provider.generateImage({ provider: "cpa", model: "gpt-image-2", prompt: "alias auth", cfg: {} });
	expect(resolveAuth.mock.calls[0][0].provider).toBe("cpa");
});

it("falls back to canonical credentials only when alias credentials are missing", async () => {
	const { dir } = fixture("cliproxyapi", false);
	const provider = buildImageGenerationProvider(dir, "cliproxyapi", ["cpa"]);
	const missing = Object.assign(new Error("missing"), { code: "missing-provider-auth" });
	resolveAuth.mockRejectedValueOnce(missing).mockResolvedValueOnce({
		apiKey: "canonical-key",
		mode: "api-key",
		source: "profile",
	});
	await provider.generateImage({ provider: "cpa", model: "gpt-image-2", prompt: "fallback auth", cfg: {} });
	expect(resolveAuth.mock.calls.map(([params]) => params.provider)).toEqual(["cpa", "cliproxyapi"]);
	expect(new Headers(fetchGuard.mock.calls[0][0].init?.headers).get("Authorization")).toBe("Bearer canonical-key");
});

it("reports availability using file credentials or host auth", () => {
	const local = fixture();
	configured.mockReturnValue(false);
	expect(local.provider.isConfigured?.({ cfg: {} })).toBe(true);
	const remote = fixture("cpa", false);
	expect(remote.provider.isConfigured?.({ cfg: {} })).toBe(false);
	configured.mockReturnValue(true);
	expect(remote.provider.isConfigured?.({ cfg: {} })).toBe(true);
	const aliased = buildImageGenerationProvider(remote.dir, "cliproxyapi", ["cpa"]);
	configured.mockImplementation(({ provider }) => provider === "cpa");
	expect(aliased.isConfigured?.({ cfg: {} })).toBe(true);
});

it("propagates authentication failures without sending requests", async () => {
	const { provider, req } = fixture("cpa", false);
	const failure = Object.assign(new Error("profile denied"), { code: "AUTH_DENIED" });
	resolveAuth.mockRejectedValueOnce(failure);
	await expect(provider.generateImage(req)).rejects.toBe(failure);
	expect(fetchGuard).not.toHaveBeenCalled();
});

it.each([401, 403, 429, 500])("fails on HTTP %s without reflecting backend credentials", async (status) => {
	const { provider, req } = fixture();
	fetchGuard.mockResolvedValueOnce({
		response: new Response("file-key private prompt", { status }),
		release,
		finalUrl: "https://cpa.example",
	});
	await expect(provider.generateImage(req)).rejects.toMatchObject({
		code: "IMAGE_HTTP_ERROR",
		status,
		message: `CLIProxyAPI image request failed (HTTP ${status})`,
	});
	expect(release).toHaveBeenCalledOnce();
});

it.each([
	{ data: [] },
	{ data: [null] },
	{ data: [{ b64_json: "%%%" }] },
	{ data: [{ b64_json: "" }] },
	{ data: [{ b64_json: "SGVsbG8=" }] },
	{ data: [{ b64_json: "SGVsbG9=" }] },
	{ data: [{ unexpected: true }] },
	{ data: [{ b64_json: png.toString("base64") }, { b64_json: png.toString("base64") }] },
])("rejects malformed image response %j", async (payload) => {
	const { provider, req } = fixture();
	fetchGuard.mockResolvedValueOnce({
		response: new Response(JSON.stringify(payload)),
		release,
		finalUrl: "https://cpa.example",
	});
	await expect(provider.generateImage(req)).rejects.toBeInstanceOf(ImageGenerationError);
	expect(release).toHaveBeenCalledOnce();
});

it("fails loudly on malformed JSON and releases the HTTP transport", async () => {
	const { provider, req } = fixture();
	fetchGuard.mockResolvedValueOnce({
		response: new Response("invalid JSON"),
		release,
		finalUrl: "https://cpa.example",
	});
	await expect(provider.generateImage(req)).rejects.toMatchObject({
		code: "INVALID_IMAGE_RESPONSE",
		message: "CLIProxyAPI returned invalid image JSON",
	});
	expect(release).toHaveBeenCalledOnce();
});

it("downloads URL results without credentials and without broad private-network opt-in", async () => {
	const { provider, req } = fixture();
	fetchGuard.mockResolvedValueOnce({
		response: new Response(JSON.stringify({ data: [{ url: "https://cdn.example/image.png" }] })),
		release,
		finalUrl: "https://cpa.example",
	});
	fetchGuard.mockResolvedValueOnce({
		response: new Response(png),
		release,
		finalUrl: "https://cdn.example/image.png",
	});
	const result = await provider.generateImage({ ...req, ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } });
	expect(result.images[0].buffer).toEqual(png);
	const download = fetchGuard.mock.calls[1][0];
	expect(download.init).toBeUndefined();
	expect(download.policy).toEqual({ hostnameAllowlist: undefined, blockedHostnames: undefined });
	expect(download.maxRedirects).toBe(0);
	expect(download.signal).toBe(fetchGuard.mock.calls[0][0].signal);
	expect(release).toHaveBeenCalledTimes(2);
});

it("retains domain restrictions while stripping foreign-download private-network exemptions", async () => {
	const { provider, req } = fixture();
	fetchGuard.mockResolvedValueOnce({
		response: new Response(JSON.stringify({ data: [{ url: "https://cdn.example/image.png" }] })),
		release,
		finalUrl: "https://cpa.example",
	});
	fetchGuard.mockResolvedValueOnce({
		response: new Response(png),
		release,
		finalUrl: "https://cdn.example/image.png",
	});
	await provider.generateImage({
		...req,
		ssrfPolicy: {
			dangerouslyAllowPrivateNetwork: true,
			allowedHostnames: ["cdn.example"],
			allowedOrigins: ["https://cdn.example"],
			hostnameAllowlist: ["cpa.example", "cdn.example"],
			blockedHostnames: ["blocked.example"],
		},
	});
	expect(fetchGuard.mock.calls[1][0].policy).toEqual({
		hostnameAllowlist: ["cpa.example", "cdn.example"],
		blockedHostnames: ["blocked.example"],
	});
});

it("decodes inline data URLs without a download", async () => {
	const { provider, req } = fixture();
	fetchGuard.mockResolvedValueOnce({
		response: new Response(JSON.stringify({ data: [{ url: `data:image/png;base64,${png.toString("base64")}` }] })),
		release,
		finalUrl: "https://cpa.example",
	});
	expect((await provider.generateImage(req)).images[0].buffer).toEqual(png);
	expect(fetchGuard).toHaveBeenCalledOnce();
});

it.each([
	"file:///secret",
	"http://user:secret@localhost/image.png",
	"data:text/html;base64,SGVsbG8=",
])("rejects unsafe asset URL %s", async (url) => {
	const { provider, req } = fixture();
	fetchGuard.mockResolvedValueOnce({
		response: new Response(JSON.stringify({ data: [{ url }] })),
		release,
		finalUrl: "https://cpa.example",
	});
	await expect(provider.generateImage(req)).rejects.toBeInstanceOf(ImageGenerationError);
	expect(fetchGuard).toHaveBeenCalledOnce();
});

it.each([
	{ count: 2 },
	{ prompt: " " },
	{ timeoutMs: 0 },
	{ timeoutMs: -1 },
	{ timeoutMs: NaN },
	{ model: "" },
])("validates image request options %j", async (overrides) => {
	const { provider, req } = fixture();
	await expect(provider.generateImage({ ...req, ...overrides })).rejects.toMatchObject({
		code: "INVALID_IMAGE_REQUEST",
	});
	expect(fetchGuard).not.toHaveBeenCalled();
});

it("rejects oversized reference images before network activity", async () => {
	const { provider, req } = fixture();
	await expect(
		provider.generateImage({
			...req,
			inputImages: [{ buffer: Buffer.alloc(IMAGE_MAX_BYTES + 1), mimeType: "image/png" }],
		}),
	).rejects.toMatchObject({ code: "INVALID_IMAGE_REQUEST" });
	expect(fetchGuard).not.toHaveBeenCalled();
});

it("bounds response size before parsing image JSON", async () => {
	const { provider, req } = fixture();
	fetchGuard.mockResolvedValueOnce({
		response: new Response(new Uint8Array(IMAGE_MAX_BYTES * 2)),
		release,
		finalUrl: "https://cpa.example",
	});
	await expect(provider.generateImage(req)).rejects.toBeInstanceOf(Error);
	expect(release).toHaveBeenCalledOnce();
});

it("propagates network failures without retrying paid generation", async () => {
	const { provider, req } = fixture();
	const failure = Object.assign(new Error("network failure"), { code: "ECONNRESET" });
	fetchGuard.mockRejectedValueOnce(failure);
	await expect(provider.generateImage(req)).rejects.toBe(failure);
	expect(fetchGuard).toHaveBeenCalledOnce();
});
