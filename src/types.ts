/**
 * Types for CLIProxyAPI OpenClaw provider plugin.
 */

export interface CliproxyConfigFile {
	baseUrl?: string;
	apiKey?: string;
	providerId?: string;
	providerName?: string;
	fast?: boolean;
	pause?: boolean;
	pricing?: boolean;
	/** Legacy config input; validated at runtime to accept only openai-responses. */
	api?: string;
}

export interface ResolvedIdentity {
	providerId: string;
	providerName: string;
}

export interface ResolvedConnection {
	baseUrlInput: string;
	apiKey?: string;
	inferenceBaseUrl: string;
	modelsUrl: string;
	rootOrigin: string;
}

export interface CodexReasoningLevel {
	effort?: string;
	description?: string;
}

export interface CodexServiceTier {
	id?: string;
	name?: string;
	description?: string;
}

export interface CodexClientModel {
	slug?: string;
	id?: string;
	display_name?: string;
	name?: string;
	description?: string;
	context_window?: number;
	max_context_window?: number;
	input_modalities?: string[];
	supports_image_detail_original?: boolean;
	supported_reasoning_levels?: CodexReasoningLevel[] | string[];
	default_service_tier?: string | null;
	service_tiers?: Array<CodexServiceTier | string>;
	additional_speed_tiers?: string[];
	visibility?: string;
}

export interface CodexClientModelsResponse {
	models?: CodexClientModel[];
	data?: CodexClientModel[];
}

export interface OpenClawCostTier {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	inputTokensAbove: number;
}

export interface OpenClawCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: OpenClawCostTier[];
}

export type ModelCategory = "chat" | "image" | "video";

export interface OpenClawProviderModel {
	id: string;
	name: string;
	provider: string;
	api: "openai-responses";
	baseUrl?: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: OpenClawCost;
	contextWindow: number;
	maxTokens: number;
	params?: Record<string, unknown>;
}

export interface ModelsCacheFile {
	fetchedAt: number;
	inferenceBaseUrl: string;
	modelsUrl: string;
	fastMode?: boolean;
	fastModelIds: string[];
	models: OpenClawProviderModel[];
}

export interface ModelsDevCostPayload {
	input?: unknown;
	output?: unknown;
	cache_read?: unknown;
	cache_write?: unknown;
	tiers?: unknown;
	context_over_200k?: unknown;
}

export interface ModelsDevModePayload {
	cost?: ModelsDevCostPayload;
}

export interface ModelsDevModelPayload {
	cost?: ModelsDevCostPayload;
	experimental?: {
		modes?: Record<string, ModelsDevModePayload | undefined>;
	};
}

export interface ModelsDevCostEntry {
	providerId: string;
	modelId: string;
	standard: OpenClawCost;
	fast?: OpenClawCost;
}

export interface ModelsDevCostCatalog {
	exact: Map<string, ModelsDevCostEntry[]>;
	normalized: Map<string, ModelsDevCostEntry[]>;
}
