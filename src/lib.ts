/**
 * Helpers for CLIProxyAPI endpoint resolution, model mapping, models.dev pricing, and configuration I/O.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	CliproxyConfigFile,
	CodexClientModel,
	CodexClientModelsResponse,
	ModelsCacheFile,
	ModelsDevCostCatalog,
	ModelsDevCostEntry,
	ModelsDevCostPayload,
	ModelsDevModelPayload,
	OpenClawCost,
	OpenClawCostTier,
	OpenClawProviderModel,
	ResolvedConnection,
	ResolvedIdentity,
} from "./types.js";

export const DEFAULT_PROVIDER_ID = "cliproxyapi";
export const DEFAULT_PROVIDER_NAME = "CLIProxyAPI";
export const DEFAULT_BASE_URL = "http://127.0.0.1:8317";
export const CONFIG_FILE_NAME = "cliproxyapi.json";
export const MODELS_CACHE_FILE_NAME = "cliproxyapi-models.json";
export const CLIENT_VERSION = "openclaw";
export const MODELS_REQUEST_TIMEOUT_MS = 60_000;
export const MODELS_DEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const DEFAULT_API_DRIVER = "openai-responses";
export const OPENCLAW_API_DRIVER = DEFAULT_API_DRIVER;
export const ZERO_COST: OpenClawCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_CONTEXT_WINDOW = 128000;

export class ModelsHttpError extends Error {
	readonly status: number;
	readonly statusText: string;

	constructor(status: number, statusText: string, body: string) {
		super(`models request failed: ${status} ${statusText}`);
		void body;
		this.name = "ModelsHttpError";
		this.status = status;
		this.statusText = statusText;
	}
}

export function isUnauthorizedModelsError(error: unknown): boolean {
	return error instanceof ModelsHttpError && error.status === 401;
}

export function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

/**
 * Resolve the OpenClaw configuration and cache directory.
 */
export function getOpenClawConfigDir(): string {
	const customDir = firstNonEmpty(process.env.OPENCLAW_STATE_DIR, process.env.OPENCLAW_CONFIG_DIR);
	if (customDir) {
		return customDir;
	}
	return join(homedir(), ".openclaw");
}

/**
 * Normalize user-provided base URL into inference + models endpoints.
 *
 * For OpenClaw with openai-responses driver:
 * - Preferred input: host:port (e.g. http://127.0.0.1:8317)
 * - inferenceBaseUrl points to {root}/v1
 * - modelsUrl points to {root}/v1/models?client_version=openclaw
 */
export function resolveEndpoints(baseUrlInput: string): {
	inferenceBaseUrl: string;
	modelsUrl: string;
	rootOrigin: string;
} {
	let raw = baseUrlInput.trim();
	if (!raw) {
		throw new Error("baseUrl is empty");
	}
	if (!/^https?:\/\//i.test(raw)) {
		raw = `http://${raw}`;
	}

	const url = new URL(raw);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
		throw new Error("Invalid base URL");
	const path = url.pathname.replace(/\/+$/, "");

	const rootOrigin = url.origin;
	let inferenceBaseUrl = "";

	if (path === "" || path === "/") {
		inferenceBaseUrl = `${url.origin}/v1`;
	} else if (path === "/v1" || path.endsWith("/v1")) {
		inferenceBaseUrl = `${url.origin}${path}`;
	} else if (path === "/backend-api" || path.endsWith("/backend-api")) {
		// Normalize legacy backend URLs to the standard Responses API base.
		const cleanPath = path.slice(0, -"/backend-api".length).replace(/\/+$/, "");
		const subPath = cleanPath ? `${cleanPath}/v1` : "/v1";
		inferenceBaseUrl = `${url.origin}${subPath}`;
	} else {
		inferenceBaseUrl = `${url.origin}${path}/v1`;
	}

	// Normalize root origin and models path
	const modelsUrl = `${inferenceBaseUrl}/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`;

	return {
		inferenceBaseUrl,
		modelsUrl,
		rootOrigin,
	};
}

export function loadConfigFile(configDir?: string): CliproxyConfigFile {
	const dir = configDir ?? getOpenClawConfigDir();
	const configPath = join(dir, CONFIG_FILE_NAME);

	try {
		if (!existsSync(configPath)) {
			return {};
		}
		const raw = readFileSync(configPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${CONFIG_FILE_NAME} must contain a JSON object`);
		}
		return parsed as CliproxyConfigFile;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return {};
		}
		throw error;
	}
}

export function saveConfigFile(configDir: string, config: CliproxyConfigFile): void {
	const configPath = join(configDir, CONFIG_FILE_NAME);
	mkdirSync(dirname(configPath), { recursive: true });

	const existing = loadConfigFile(configDir);
	const next: CliproxyConfigFile = {
		...existing,
		...config,
	};
	if (existsSync(configPath)) chmodSync(configPath, 0o600);
	writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function parseBooleanSetting(value: string): boolean | undefined {
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return undefined;
	}
}

export function resolveFastDefault(configFile?: CliproxyConfigFile): boolean {
	const envValue = firstNonEmpty(process.env.CLIPROXYAPI_FAST, process.env.CPA_FAST);
	if (envValue !== undefined) {
		const parsed = parseBooleanSetting(envValue);
		if (parsed === undefined) {
			throw new Error(`CLIPROXYAPI_FAST / CPA_FAST must be one of: true, false, 1, 0, yes, no, on, off`);
		}
		return parsed;
	}

	if (configFile?.fast !== undefined) {
		if (typeof configFile.fast !== "boolean") {
			throw new Error(`${CONFIG_FILE_NAME} field "fast" must be a boolean`);
		}
		return configFile.fast;
	}

	return false;
}

export function resolveApiDriver(configFile?: CliproxyConfigFile): "openai-responses" {
	const driver = firstNonEmpty(
		process.env.CLIPROXYAPI_API_DRIVER,
		process.env.CLIPROXYAPI_API,
		process.env.CPA_API_DRIVER,
		process.env.CPA_API,
		configFile?.api,
		DEFAULT_API_DRIVER,
	)!;
	if (driver !== "openai-responses")
		throw new Error("Unsupported API driver; only openai-responses is supported. Remove legacy API overrides.");
	return driver;
}

export function resolveIdentity(configFile?: CliproxyConfigFile): ResolvedIdentity {
	return {
		providerId: firstNonEmpty(
			process.env.CLIPROXYAPI_PROVIDER_ID,
			process.env.CPA_PROVIDER_ID,
			configFile?.providerId,
			DEFAULT_PROVIDER_ID,
		)!,
		providerName: firstNonEmpty(
			process.env.CLIPROXYAPI_PROVIDER_NAME,
			process.env.CPA_PROVIDER_NAME,
			configFile?.providerName,
			DEFAULT_PROVIDER_NAME,
		)!,
	};
}

export function resolveConnection(
	configDir?: string,
	extraApiKey?: string,
): ResolvedConnection & { apiDriver: "openai-responses" } {
	const configFile = loadConfigFile(configDir);

	const apiDriver = resolveApiDriver(configFile);
	const baseUrlInput = firstNonEmpty(
		process.env.CLIPROXYAPI_BASE_URL,
		process.env.CPA_BASE_URL,
		configFile.baseUrl,
		DEFAULT_BASE_URL,
	)!;
	const apiKey = firstNonEmpty(
		process.env.CLIPROXYAPI_API_KEY,
		process.env.CPA_API_KEY,
		configFile.apiKey,
		extraApiKey,
	);
	const endpoints = resolveEndpoints(baseUrlInput);

	return {
		baseUrlInput,
		apiKey,
		inferenceBaseUrl: endpoints.inferenceBaseUrl,
		modelsUrl: endpoints.modelsUrl,
		rootOrigin: endpoints.rootOrigin,
		apiDriver,
	};
}

export function extractReasoningEfforts(model: CodexClientModel): string[] {
	const raw = model.supported_reasoning_levels ?? [];
	const efforts: string[] = [];
	for (const entry of raw) {
		const effort = typeof entry === "string" ? entry : typeof entry?.effort === "string" ? entry.effort : "";
		const normalized = effort.trim().toLowerCase();
		if (!normalized) continue;
		if (!efforts.includes(normalized)) {
			efforts.push(normalized);
		}
	}
	return efforts;
}

export function buildInputModalities(model: CodexClientModel): Array<"text" | "image"> {
	const raw = model.input_modalities ?? [];
	const input: Array<"text" | "image"> = [];
	for (const modality of raw) {
		const value = String(modality).trim().toLowerCase();
		if ((value === "text" || value === "image") && !input.includes(value)) {
			input.push(value);
		}
	}
	if (model.supports_image_detail_original && !input.includes("image")) {
		input.push("image");
	}
	if (!input.includes("text")) {
		input.unshift("text");
	}
	return input;
}

export function codexModelId(model: CodexClientModel): string {
	return (model.slug ?? model.id ?? "").trim();
}

export type ModelCategory = "chat" | "image" | "video";

const VIDEO_MODEL_PATTERN = /(?:^|[._/-])(video|sora|veo|kling|gen-?[23]|hailuo|minimax-video|luma-ray)(?:$|[._/-])/i;

const IMAGE_GENERATION_MODEL_PATTERN =
	/(?:^|[._/-])(image|imagen|imagine|flux|dall-?e|stable-diffusion|sdxl|midjourney|paint|draw)(?:$|[._/-])/i;

export function classifyModel(model: CodexClientModel | string): ModelCategory {
	const id = typeof model === "string" ? model.trim() : codexModelId(model);
	if (!id) return "chat";

	// 1. Check video generation (handles compound names like grok-imagine-video)
	if (VIDEO_MODEL_PATTERN.test(id)) {
		return "video";
	}

	// 2. Check image generation (e.g. gpt-image-2, grok-imagine-image, gemini-3.1-flash-image)
	if (IMAGE_GENERATION_MODEL_PATTERN.test(id)) {
		return "image";
	}

	return "chat";
}

export function supportsFastServiceTier(model: CodexClientModel): boolean {
	return (
		Array.isArray(model.service_tiers) &&
		model.service_tiers.some(
			(tier) => (typeof tier === "string" ? tier : tier?.id)?.trim().toLowerCase() === "priority",
		)
	);
}

export function toOpenClawModel(
	model: CodexClientModel,
	providerId: string,
	costCatalog?: ModelsDevCostCatalog,
	fastMode = false,
): OpenClawProviderModel | null {
	const id = codexModelId(model);
	if (!id) {
		return null;
	}

	const category = classifyModel(model);
	let name = (model.display_name ?? model.name ?? id).trim() || id;
	if (category === "image" && !/\[(?:image|\u751f\u56fe)/i.test(name)) {
		name = `${name} [Image Gen]`;
	} else if (category === "video" && !/\[(?:video|\u89c6\u9891)/i.test(name)) {
		name = `${name} [Video Gen]`;
	}

	const input = buildInputModalities(model);

	const efforts = extractReasoningEfforts(model);
	const hasReasoning = efforts.some((effort) => effort !== "none");
	const contextWindow =
		(typeof model.context_window === "number" && model.context_window > 0 ? model.context_window : undefined) ??
		(typeof model.max_context_window === "number" && model.max_context_window > 0
			? model.max_context_window
			: undefined) ??
		DEFAULT_CONTEXT_WINDOW;

	const isFastSupported = supportsFastServiceTier(model);
	const isFastEffective = fastMode && isFastSupported;

	const cost = costCatalog ? matchModelCost(id, costCatalog, isFastEffective) : { ...ZERO_COST };

	const modelObj: OpenClawProviderModel = {
		id,
		name,
		provider: providerId,
		api: DEFAULT_API_DRIVER,
		reasoning: hasReasoning,
		input,
		cost,
		contextWindow,
		maxTokens: DEFAULT_MAX_TOKENS,
	};

	if (isFastEffective) {
		modelObj.params = {
			service_tier: "priority",
			extra_body: {
				service_tier: "priority",
			},
		};
	}

	return modelObj;
}

export async function fetchCodexModels(
	modelsUrl: string,
	apiKey?: string,
	timeoutMs = MODELS_REQUEST_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<CodexClientModel[]> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	const response = await fetch(modelsUrl, {
		headers,
		signal: requestSignal,
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new ModelsHttpError(response.status, response.statusText, body);
	}

	const payload: unknown = await response.json();
	const obj = payload as CodexClientModelsResponse | null;
	const rows = Array.isArray(payload) ? payload : (obj?.models ?? obj?.data);
	if (
		!Array.isArray(rows) ||
		rows.some(
			(row) =>
				!row || typeof row !== "object" || typeof (row.slug ?? row.id) !== "string" || !(row.slug ?? row.id).trim(),
		)
	)
		throw new Error("Invalid model catalog response");
	return rows;
}

export function loadModelsCache(cacheDir?: string, baseUrlInput?: string): ModelsCacheFile | null {
	const dir = cacheDir ?? getOpenClawConfigDir();
	const cachePath = join(dir, MODELS_CACHE_FILE_NAME);

	try {
		if (!existsSync(cachePath)) {
			return null;
		}
		const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<ModelsCacheFile>;
		if (baseUrlInput) {
			const endpoints = resolveEndpoints(baseUrlInput);
			if (parsed.modelsUrl !== endpoints.modelsUrl || parsed.inferenceBaseUrl !== endpoints.inferenceBaseUrl) {
				return null;
			}
		}
		if (
			typeof parsed.fetchedAt !== "number" ||
			!Array.isArray(parsed.models) ||
			!Array.isArray(parsed.fastModelIds)
		) {
			return null;
		}
		return parsed as ModelsCacheFile;
	} catch {
		return null;
	}
}

export function saveModelsCache(cacheDir: string, cache: ModelsCacheFile): void {
	const cachePath = join(cacheDir, MODELS_CACHE_FILE_NAME);
	mkdirSync(dirname(cachePath), { recursive: true });
	writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

/* ========================================================================== */
/* Pricing Logic (models.dev)                                                 */
/* ========================================================================== */

const MODEL_NAMESPACE_PREFIX =
	/^(openai|anthropic|google(?:-vertex)?|xai|deepseek|mistral|cohere|zhipuai|moonshotai|minimax|meta)[/:.]/i;

const MODEL_PROVIDER_PREFERENCES: Array<{ pattern: RegExp; providers: string[] }> = [
	{ pattern: /^(?:gpt-|o[134](?:-|$)|chatgpt-|codex-)/, providers: ["openai", "openai-codex", "opencode"] },
	{ pattern: /^claude-/, providers: ["anthropic"] },
	{ pattern: /^(?:gemini-|gemma-)/, providers: ["google", "google-vertex"] },
	{ pattern: /^grok-/, providers: ["xai"] },
	{ pattern: /^deepseek-/, providers: ["deepseek"] },
	{ pattern: /^mistral-/, providers: ["mistral"] },
	{ pattern: /^command-/, providers: ["cohere"] },
	{ pattern: /^glm-/, providers: ["zhipuai"] },
	{ pattern: /^(?:kimi-|moonshot-)/, providers: ["moonshotai"] },
	{ pattern: /^minimax-/, providers: ["minimax"] },
	{ pattern: /^llama-/, providers: ["meta"] },
];

const MODEL_PRICE_ALIASES: Record<string, string[]> = {
	"gemini-pro-agent": ["gemini-3.1-pro-preview"],
	"gemini-3.1-pro-low": ["gemini-3.1-pro-preview"],
	"gemini-3.6-flash-high": ["gemini-3.6-flash"],
	"gemini-3-flash-agent": ["gemini-3.5-flash"],
	"grok-composer-2.5-fast": ["grok-4.3"],
	"grok-3-mini": ["xai/grok-3-mini"],
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readCostRate(
	source: Record<string, unknown>,
	key: "input" | "output" | "cacheRead" | "cacheWrite",
	fallback: number,
): number {
	const rawKey = key === "cacheRead" ? "cache_read" : key === "cacheWrite" ? "cache_write" : key;
	return finiteNumber(source[key] ?? source[rawKey]) ?? fallback;
}

function parseModelsDevCost(raw: ModelsDevCostPayload | undefined): OpenClawCost | undefined {
	if (!raw) return undefined;
	const source = raw as Record<string, unknown>;
	const input = finiteNumber(source.input);
	const output = finiteNumber(source.output);
	if (input === undefined && output === undefined) return undefined;

	const cost: OpenClawCost = {
		input: input ?? 0,
		output: output ?? 0,
		cacheRead: readCostRate(source, "cacheRead", 0),
		cacheWrite: readCostRate(source, "cacheWrite", 0),
	};
	const tiers = new Map<number, OpenClawCostTier>();

	const addTier = (rawTier: unknown, fallbackThreshold?: number): void => {
		const tierSource = asRecord(rawTier);
		if (!tierSource) return;
		const descriptor = asRecord(tierSource.tier);
		if (descriptor?.type !== undefined && descriptor.type !== "context") return;
		const threshold =
			finiteNumber(tierSource.inputTokensAbove) ?? finiteNumber(descriptor?.size) ?? fallbackThreshold;
		if (threshold === undefined || threshold <= 0) return;
		tiers.set(threshold, {
			input: readCostRate(tierSource, "input", cost.input),
			output: readCostRate(tierSource, "output", cost.output),
			cacheRead: readCostRate(tierSource, "cacheRead", cost.cacheRead),
			cacheWrite: readCostRate(tierSource, "cacheWrite", cost.cacheWrite),
			inputTokensAbove: threshold,
		});
	};

	if (Array.isArray(source.tiers)) {
		for (const tier of source.tiers) addTier(tier);
	}
	if (tiers.size === 0) {
		addTier(source.context_over_200k, 200000);
	}
	if (tiers.size > 0) {
		cost.tiers = Array.from(tiers.values()).sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
	}
	return cost;
}

function cloneCost(cost: OpenClawCost): OpenClawCost {
	return {
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead,
		cacheWrite: cost.cacheWrite,
		...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}),
	};
}

function stripModelNamespace(modelId: string): string {
	return modelId.trim().toLowerCase().replace(MODEL_NAMESPACE_PREFIX, "");
}

function normalizeModelKey(modelId: string): string {
	return stripModelNamespace(modelId).replace(/[^a-z0-9]/g, "");
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function preferredProvidersForModel(modelId: string): string[] {
	const normalizedId = stripModelNamespace(modelId);
	const namespace = modelId.trim().toLowerCase().match(MODEL_NAMESPACE_PREFIX)?.[1];
	const familyProviders =
		MODEL_PROVIDER_PREFERENCES.find(({ pattern }) => pattern.test(normalizedId))?.providers ?? [];
	return uniqueStrings([namespace ?? "", ...familyProviders]);
}

function addCatalogEntry(catalog: Map<string, ModelsDevCostEntry[]>, key: string, entry: ModelsDevCostEntry): void {
	if (!key) return;
	const entries = catalog.get(key) ?? [];
	if (!entries.some((candidate) => candidate.providerId === entry.providerId && candidate.modelId === entry.modelId)) {
		entries.push(entry);
		catalog.set(key, entries);
	}
}

function addModelsDevEntry(catalog: ModelsDevCostCatalog, entry: ModelsDevCostEntry): void {
	const rawId = entry.modelId.trim().toLowerCase();
	const strippedId = stripModelNamespace(rawId);
	for (const key of uniqueStrings([rawId, strippedId])) {
		addCatalogEntry(catalog.exact, key, entry);
	}
	addCatalogEntry(catalog.normalized, normalizeModelKey(rawId), entry);
}

function sameCostVariants(entries: ModelsDevCostEntry[]): boolean {
	const fingerprints = new Set(entries.map((entry) => JSON.stringify({ standard: entry.standard, fast: entry.fast })));
	return fingerprints.size === 1;
}

function selectModelsDevEntry(entries: ModelsDevCostEntry[], modelId: string): ModelsDevCostEntry | undefined {
	if (entries.length === 0) return undefined;
	const preferredProviders = preferredProvidersForModel(modelId);
	for (const providerId of preferredProviders) {
		const match = entries.find((entry) => entry.providerId === providerId);
		if (match) return match;
	}
	if (entries.length === 1 || sameCostVariants(entries)) {
		return [...entries].sort((a, b) => a.providerId.localeCompare(b.providerId))[0];
	}
	return undefined;
}

function findDirectModelsDevEntry(modelId: string, catalog: ModelsDevCostCatalog): ModelsDevCostEntry | undefined {
	const rawId = modelId.trim().toLowerCase();
	const exactKeys = uniqueStrings([rawId, stripModelNamespace(rawId)]);
	for (const key of exactKeys) {
		const match = selectModelsDevEntry(catalog.exact.get(key) ?? [], modelId);
		if (match) return match;
	}
	return selectModelsDevEntry(catalog.normalized.get(normalizeModelKey(rawId)) ?? [], modelId);
}

function findModelsDevEntry(modelId: string, catalog: ModelsDevCostCatalog): ModelsDevCostEntry | undefined {
	const rawId = modelId.trim().toLowerCase();
	const lookupIds = uniqueStrings([rawId, ...(MODEL_PRICE_ALIASES[rawId] ?? [])]);
	for (const lookupId of lookupIds) {
		const match = findDirectModelsDevEntry(lookupId, catalog);
		if (match) return match;
	}
	return undefined;
}

interface ModelsDevCachePayload {
	timestamp: number;
	providers: Record<string, unknown>;
}

function getModelsDevCachePath(cacheDir?: string): string {
	if (cacheDir?.trim()) {
		return join(cacheDir, "models-dev-cache.json");
	}
	return join(tmpdir(), "openclaw-cliproxyapi-models-dev-cache.json");
}

function readModelsDevCacheFile(cachePath: string): ModelsDevCachePayload | null {
	try {
		if (!existsSync(cachePath)) return null;
		const raw = readFileSync(cachePath, "utf8");
		const parsed = asRecord(JSON.parse(raw));
		if (!parsed || typeof parsed.timestamp !== "number" || !Number.isFinite(parsed.timestamp)) return null;
		const providers = asRecord(parsed.providers);
		if (!providers || !isModelsDevProviders(providers)) return null;
		return { timestamp: parsed.timestamp, providers };
	} catch {
		return null;
	}
}

function writeModelsDevCacheFile(cachePath: string, providers: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(cachePath), { recursive: true });
		const payload: ModelsDevCachePayload = {
			timestamp: Date.now(),
			providers,
		};
		writeFileSync(cachePath, JSON.stringify(payload), "utf8");
	} catch {
		// Ignore write failure (e.g. read-only filesystem)
	}
}

function isModelsDevProviders(value: Record<string, unknown>): boolean {
	return Object.values(value).some((providerValue) => {
		const provider = asRecord(providerValue);
		return asRecord(provider?.models) !== undefined;
	});
}

function buildCatalogFromProviders(providers: Record<string, unknown>): ModelsDevCostCatalog {
	const catalog: ModelsDevCostCatalog = { exact: new Map(), normalized: new Map() };
	for (const [providerId, providerValue] of Object.entries(providers)) {
		const provider = asRecord(providerValue);
		const models = asRecord(provider?.models);
		if (!models) continue;
		for (const [modelId, modelValue] of Object.entries(models)) {
			const model = asRecord(modelValue) as ModelsDevModelPayload | undefined;
			const standard = parseModelsDevCost(model?.cost);
			if (!standard) continue;
			const fast = parseModelsDevCost(model?.experimental?.modes?.fast?.cost);
			addModelsDevEntry(catalog, { providerId, modelId, standard, fast });
		}
	}
	return catalog;
}

export async function fetchModelsDevCostMap(
	cacheDir?: string,
	forceRefresh = false,
	signal?: AbortSignal,
): Promise<ModelsDevCostCatalog> {
	const cachePath = getModelsDevCachePath(cacheDir);
	const cached = readModelsDevCacheFile(cachePath);

	if (!forceRefresh && cached && Date.now() - cached.timestamp < MODELS_DEV_CACHE_TTL_MS) {
		return buildCatalogFromProviders(cached.providers);
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 3000);
	const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	try {
		const response = await fetch("https://models.dev/api.json", { signal: requestSignal });
		if (response.ok) {
			const providers = asRecord(await response.json());
			if (providers && isModelsDevProviders(providers)) {
				writeModelsDevCacheFile(cachePath, providers);
				return buildCatalogFromProviders(providers);
			}
		}
	} catch {
		// Retain stale cache if network/JSON fails
	} finally {
		clearTimeout(timeoutId);
	}

	if (cached) {
		return buildCatalogFromProviders(cached.providers);
	}

	return { exact: new Map(), normalized: new Map() };
}

export function matchModelCost(modelId: string, costCatalog: ModelsDevCostCatalog, isFastMode = false): OpenClawCost {
	const entry = findModelsDevEntry(modelId, costCatalog);
	if (!entry) return { ...ZERO_COST };
	return cloneCost(isFastMode && entry.fast ? entry.fast : entry.standard);
}

/**
 * Fallback static models to keep the gateway running if upstream CPA is offline during startup.
 */
export const FALLBACK_MODELS: Array<Omit<OpenClawProviderModel, "provider">> = [
	{
		id: "gpt-4o",
		name: "GPT-4o",
		api: OPENCLAW_API_DRIVER,
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128000,
		maxTokens: 16384,
		cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
	},
	{
		id: "claude-3-7-sonnet-20250219",
		name: "Claude 3.7 Sonnet",
		api: OPENCLAW_API_DRIVER,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 200000,
		maxTokens: 64000,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		api: OPENCLAW_API_DRIVER,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		cost: { input: 1.25, output: 5, cacheRead: 0.3125, cacheWrite: 1.25 },
	},
	{
		id: "deepseek-chat",
		name: "DeepSeek V3",
		api: OPENCLAW_API_DRIVER,
		reasoning: false,
		input: ["text"],
		contextWindow: 64000,
		maxTokens: 8192,
		cost: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
	},
];

/**
 * Construct an on-the-fly model object for resolveDynamicModel.
 */
export function createDynamicModel(
	modelId: string,
	providerId: string,
	baseUrl: string,
	costCatalog?: ModelsDevCostCatalog,
	fastMode = false,
): OpenClawProviderModel & { baseUrl: string } {
	const normalizedId = modelId.trim();
	const isReasoning =
		/^(?:o1|o3|deepseek-reasoner|qwq)/i.test(normalizedId) || /(?:thinking|reasoning)/i.test(normalizedId);

	const cost = costCatalog ? matchModelCost(normalizedId, costCatalog, fastMode) : { ...ZERO_COST };

	return {
		id: normalizedId,
		name: normalizedId,
		provider: providerId,
		api: DEFAULT_API_DRIVER,
		baseUrl,
		reasoning: isReasoning,
		input: ["text", "image"],
		cost,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		...(fastMode ? { params: { service_tier: "priority" } } : {}),
	};
}
