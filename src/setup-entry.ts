import type { ProviderAuthMethod, ProviderAuthResult } from "openclaw/plugin-sdk/core";
import {
	classifyModel,
	DEFAULT_BASE_URL,
	fetchCodexModels,
	loadConfigFile,
	resolveEndpoints,
	resolveFastDefault,
	saveConfigFile,
	saveModelsCache,
	supportsFastServiceTier,
	toOpenClawModel,
} from "./lib.js";

export function createAuthMethod(configDir: string, providerId: string): ProviderAuthMethod {
	return {
		id: "api-key",
		label: "CLIProxyAPI Base URL and API Key",
		kind: "api_key",
		wizard: {
			choiceId: `${providerId}-api-key`,
			choiceLabel: `CLIProxyAPI (${providerId})`,
			groupId: "cliproxyapi",
			groupLabel: "CLIProxyAPI",
		},
		async run(ctx) {
			const existing = loadConfigFile(configDir);
			const baseUrl = (
				await ctx.prompter.text({
					message: "CLIProxyAPI Base URL",
					initialValue: existing.baseUrl ?? DEFAULT_BASE_URL,
				})
			).trim();
			const endpoints = resolveEndpoints(baseUrl);
			const apiKey = (
				await ctx.prompter.text({
					message: "CLIProxyAPI API Key",
					sensitive: true,
					validate: (value) => (value.trim() ? undefined : "API Key is required"),
				})
			).trim();
			if (!apiKey) throw new Error("API Key is required");
			const remote = await fetchCodexModels(endpoints.modelsUrl, apiKey, undefined, ctx.signal);
			const fastMode = resolveFastDefault(existing);
			const fastModelIds = remote.filter(supportsFastServiceTier).map((m) => (m.slug ?? m.id ?? "").trim());
			const models = remote
				.map((m) => toOpenClawModel(m, providerId, undefined, fastMode))
				.filter((m) => m !== null);

			// Catalog visibility does not imply a registered media-generation runtime.
			const chatModels = models.filter((m) => classifyModel(m.id) === "chat");
			let primaryModelId: string | undefined;
			let fallbackModelIds: string[] = [];
			if (chatModels.length > 0) {
				const options = chatModels.map((m) => ({
					value: m.id,
					label: m.name,
					hint: `${Math.round(m.contextWindow / 1000)}k ctx${m.reasoning ? " • Reasoning" : ""}`,
				}));
				primaryModelId = await ctx.prompter.select<string>({
					message: "Select the primary chat model",
					options,
					initialValue: chatModels[0].id,
					searchable: true,
				});
				if (!chatModels.some((m) => m.id === primaryModelId)) {
					throw Object.assign(new Error("Selected primary model is not in the chat catalog"), {
						code: "INVALID_PRIMARY_MODEL",
					});
				}
				const fallbackOptions = options.filter((option) => option.value !== primaryModelId);
				if (fallbackOptions.length > 0) {
					fallbackModelIds = await ctx.prompter.multiselect<string>({
						message: "Select fallback chat models (optional)",
						options: fallbackOptions,
						searchable: true,
					});
					if (fallbackModelIds.some((id) => !fallbackOptions.some((option) => option.value === id))) {
						throw Object.assign(new Error("Selected fallback model is not in the fallback catalog"), {
							code: "INVALID_FALLBACK_MODEL",
						});
					}
					fallbackModelIds = [...new Set(fallbackModelIds)];
				}
			}

			const imageModels = models.filter((m) => classifyModel(m.id) === "image");
			let imageModelId: string | undefined;
			let imageFallbackIds: string[] = [];
			if (imageModels.length > 0) {
				const selected = await ctx.prompter.select<string>({
					message: "Select an image generation model (skip to preserve current settings)",
					options: [
						{ value: "", label: "Skip and preserve current image generation settings" },
						...imageModels.map((m) => ({ value: m.id, label: m.name })),
					],
					initialValue: "",
					searchable: true,
				});
				if (selected !== "") {
					if (!imageModels.some((m) => m.id === selected)) {
						throw Object.assign(new Error("Selected image model is not in the image catalog"), {
							code: "INVALID_IMAGE_MODEL",
						});
					}
					imageModelId = selected;
					const options = imageModels
						.filter((m) => m.id !== selected)
						.map((m) => ({ value: m.id, label: m.name }));
					if (options.length > 0) {
						imageFallbackIds = await ctx.prompter.multiselect<string>({
							message: "Select fallback image generation models (optional)",
							options,
							searchable: true,
						});
						if (imageFallbackIds.some((id) => !options.some((option) => option.value === id))) {
							throw Object.assign(new Error("Selected image fallback is not in the image catalog"), {
								code: "INVALID_IMAGE_FALLBACK",
							});
						}
						imageFallbackIds = [...new Set(imageFallbackIds)];
					}
				}
			}

			const configPatch: NonNullable<ProviderAuthResult["configPatch"]> = {};
			// Older releases wrote explicit provider routes that override discovery.
			// Sync existing routes (including the shared alias), without adding catalog rows.
			const providerIds =
				providerId === "cliproxyapi" || providerId === "cpa" ? ["cliproxyapi", "cpa"] : [providerId];
			for (const id of providerIds) {
				const provider = ctx.config.models?.providers?.[id];
				if (!provider) continue;
				configPatch.models ??= { providers: {} };
				configPatch.models.providers![id] = {
					...provider,
					baseUrl: endpoints.inferenceBaseUrl,
					api: "openai-responses",
					models: provider.models ?? [],
				};
			}
			if (primaryModelId) {
				const selectedRefs = [primaryModelId, ...fallbackModelIds].map((id) => `${providerId}/${id}`);
				configPatch.agents = {
					defaults: {
						model: { primary: selectedRefs[0], fallbacks: selectedRefs.slice(1) },
						...(ctx.config.agents?.defaults?.models
							? { models: Object.fromEntries(selectedRefs.map((ref) => [ref, {}])) }
							: {}),
					},
				};
			}

			if (imageModelId) {
				configPatch.agents ??= {};
				configPatch.agents.defaults ??= {};
				configPatch.agents.defaults.mediaModels = {
					image: {
						primary: `${providerId}/${imageModelId}`,
						fallbacks: imageFallbackIds.map((id) => `${providerId}/${id}`),
					},
				};
			}

			// Complete all prompts before any writes. Cache failures must abort login
			// before replacing the existing connection or clearing its local credential.
			ctx.signal?.throwIfAborted();
			saveModelsCache(configDir, {
				fetchedAt: Date.now(),
				inferenceBaseUrl: endpoints.inferenceBaseUrl,
				modelsUrl: endpoints.modelsUrl,
				fastMode,
				fastModelIds,
				models,
			});
			// The host persists secrets in auth profiles; only save non-secret settings here.
			saveConfigFile(configDir, { baseUrl, api: "openai-responses", apiKey: undefined });
			// Keep the selected model in configPatch instead of defaultModel: OpenClaw's
			// --set-default helper adds defaultModel to agents.defaults.models, which would
			// turn an otherwise unrestricted setup into an allowlist.
			return {
				profiles: [
					{
						profileId: `${providerId}:default`,
						credential: { type: "api_key", provider: providerId, key: apiKey },
					},
				],
				...(Object.keys(configPatch).length > 0 ? { configPatch } : {}),
				...(models.some((m) => classifyModel(m.id) === "video")
					? {
							notes: [
								"Video models were detected, but video generation is not supported; video settings were unchanged.",
							],
						}
					: {}),
			};
		},
	};
}
