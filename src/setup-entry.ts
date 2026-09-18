import type { ProviderAuthMethod } from "openclaw/plugin-sdk/core";
import {
	DEFAULT_BASE_URL,
	fetchCodexModels,
	loadConfigFile,
	resolveEndpoints,
	saveConfigFile,
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
			const models = remote
				.map((m) => toOpenClawModel(m, providerId))
				.filter((m) => m !== null)
				// Provider identity belongs to the enclosing config key, not the model definition.
				.map(({ provider: _provider, ...model }) => model);
			// The host persists secrets in auth profiles; only save non-secret settings here.
			saveConfigFile(configDir, { baseUrl, api: "openai-responses", apiKey: undefined });
			return {
				profiles: [
					{
						profileId: `${providerId}:default`,
						credential: { type: "api_key", provider: providerId, key: apiKey },
					},
				],
				configPatch: {
					models: {
						providers: { [providerId]: { baseUrl: endpoints.inferenceBaseUrl, api: "openai-responses", models } },
					},
				},
				...(models[0] ? { defaultModel: `${providerId}/${models[0].id}` } : {}),
			};
		},
	};
}
