import type { OpenClawPluginApi, OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
import { buildImageGenerationProvider } from "./image-generation.js";
import {
	createDynamicModel,
	fetchCodexModels,
	fetchModelsDevCostMap,
	getOpenClawConfigDir,
	loadConfigFile,
	loadModelsCache,
	resolveConnection,
	resolveFastDefault,
	resolveIdentity,
	saveModelsCache,
	supportsFastServiceTier,
	toOpenClawModel,
} from "./lib.js";
import { createRefreshService } from "./refresh-service.js";
import { createAuthMethod } from "./setup-entry.js";

type Provider = Parameters<OpenClawPluginApi["registerProvider"]>[0];

export function buildProviderRegistration(
	options: {
		configDir?: string;
		providerId?: string;
		onLog?: (level: "info" | "warn" | "error", message: string) => void;
	} = {},
): Provider {
	const configDir = options.configDir ?? getOpenClawConfigDir();
	const identity = resolveIdentity(loadConfigFile(configDir));
	const id = options.providerId ?? identity.providerId;
	const fastMode = resolveFastDefault(loadConfigFile(configDir));
	const fastModels = new Set<string>();
	return {
		id,
		label: identity.providerName,
		envVars: ["CLIPROXYAPI_API_KEY", "CPA_API_KEY"],
		auth: [createAuthMethod(configDir, id)],
		catalog: {
			order: "simple",
			async run(ctx) {
				const ownAuth = ctx.resolveProviderApiKey(id);
				const auth = ownAuth.apiKey ? ownAuth : ctx.resolveProviderApiKey(identity.providerId);
				const conn = resolveConnection(configDir, auth.apiKey);
				if (!conn.apiKey) return null;
				// Host catalog markers are not bearer credentials for discovery requests.
				const discoveryKey = conn.apiKey === auth.apiKey ? (auth.discoveryApiKey ?? auth.apiKey) : conn.apiKey;
				let models: NonNullable<ReturnType<typeof toOpenClawModel>>[];
				try {
					const [remote, costs] = await Promise.all([
						fetchCodexModels(conn.modelsUrl, discoveryKey),
						fetchModelsDevCostMap(configDir),
					]);
					fastModels.clear();
					for (const m of remote) if (supportsFastServiceTier(m)) fastModels.add((m.slug ?? m.id ?? "").trim());
					models = remote.map((m) => toOpenClawModel(m, id, costs, fastMode)).filter((m) => m !== null);
					try {
						saveModelsCache(configDir, {
							fetchedAt: Date.now(),
							inferenceBaseUrl: conn.inferenceBaseUrl,
							modelsUrl: conn.modelsUrl,
							fastMode,
							fastModelIds: [...fastModels],
							models,
						});
					} catch {
						options.onLog?.("warn", "Failed to write models cache; discovered models are still usable.");
					}
				} catch (error) {
					if (error instanceof Error && "status" in error && (error.status === 401 || error.status === 403))
						throw error;
					const cached = loadModelsCache(configDir, conn.baseUrlInput);
					if (!cached) throw error;
					models = cached.models.map((m) => ({ ...m, provider: id, api: conn.apiDriver }));
					fastModels.clear();
					for (const modelId of cached.fastModelIds) fastModels.add(modelId);
					options.onLog?.("warn", "Model discovery failed; falling back to cached models.");
				}
				return { provider: { baseUrl: conn.inferenceBaseUrl, api: conn.apiDriver, apiKey: conn.apiKey, models } };
			},
		},
		resolveDynamicModel(ctx) {
			const conn = resolveConnection(configDir);
			return createDynamicModel(
				ctx.modelId,
				id,
				ctx.providerConfig?.baseUrl ?? conn.inferenceBaseUrl,
				undefined,
				false,
			);
		},
		wrapStreamFn(ctx) {
			const stream = ctx.streamFn;
			if (!stream || !fastMode) return stream;
			// Discovery and inference may load separate plugin instances.
			const conn = resolveConnection(configDir);
			const cached = loadModelsCache(configDir, conn.baseUrlInput);
			if (!(cached ? cached.fastModelIds.includes(ctx.modelId) : fastModels.has(ctx.modelId))) return stream;
			return (model, context, opts) =>
				stream(model, context, {
					...opts,
					onPayload: async (payload, payloadModel) => {
						const next = (await opts?.onPayload?.(payload, payloadModel)) ?? payload;
						if (next && typeof next === "object") return { ...next, service_tier: "priority" };
						return next;
					},
				});
		},
	};
}

export const plugin = {
	id: "cliproxyapi",
	name: "CLIProxyAPI",
	register(api: OpenClawPluginApi) {
		const configDir = getOpenClawConfigDir();
		const primary = buildProviderRegistration({ configDir, onLog: (level, msg) => api.logger[level](msg) });
		api.registerProvider(primary);
		api.registerImageGenerationProvider(
			buildImageGenerationProvider(configDir, primary.id, primary.id === "cliproxyapi" ? ["cpa"] : []),
		);
		api.registerService(createRefreshService(primary.id === "cliproxyapi" ? [primary.id, "cpa"] : [primary.id]));
		if (primary.id === "cliproxyapi") {
			api.registerProvider(
				buildProviderRegistration({ configDir, providerId: "cpa", onLog: (level, msg) => api.logger[level](msg) }),
			);
		}
	},
} satisfies OpenClawPluginDefinition;
export default plugin;
