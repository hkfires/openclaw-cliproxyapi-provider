import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { detectMime, extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/media-runtime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveConnection } from "./lib.js";

type ImageProvider = Parameters<OpenClawPluginApi["registerImageGenerationProvider"]>[0];
type ImageRequest = Parameters<ImageProvider["generateImage"]>[0];

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_JSON_MAX_BYTES = Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 1024 * 1024;
const IMAGE_TIMEOUT_MS = 180_000;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export class ImageGenerationError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "ImageGenerationError";
	}
}

function decodeImageBase64(value: unknown): Buffer {
	if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4) {
		throw new ImageGenerationError("INVALID_IMAGE_DATA", "Missing or oversized image data");
	}
	if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
		throw new ImageGenerationError("INVALID_IMAGE_DATA", "Invalid image Base64 encoding");
	}
	const buffer = Buffer.from(value, "base64");
	if (!buffer.length || buffer.length > IMAGE_MAX_BYTES || buffer.toString("base64") !== value) {
		throw new ImageGenerationError("INVALID_IMAGE_DATA", "Invalid image Base64 encoding or size");
	}
	return buffer;
}

/** CPA connection/auth normalization plus the OpenClaw image-generation contract. */
export function buildImageGenerationProvider(
	configDir: string,
	providerId: string,
	aliases: string[] = [],
): ImageProvider {
	return {
		id: providerId,
		...(aliases.length > 0 ? { aliases } : {}),
		label: "CLIProxyAPI Images",
		// Models are selected explicitly through mediaModels.image or --model.
		// Omitting an automatic default prevents an alias ref from being retried
		// against this same paid backend under the canonical provider id.
		defaultTimeoutMs: IMAGE_TIMEOUT_MS,
		capabilities: {
			generate: { maxCount: 1, supportsSize: true },
			edit: { enabled: true, maxCount: 1, maxInputImages: 1, supportsSize: true },
			output: {
				qualitiesByModel: {
					"gpt-image-1.5": ["low", "medium", "high", "auto"],
					"gpt-image-2": ["low", "medium", "high", "auto"],
				},
				formatsByModel: {
					"gpt-image-1.5": ["png", "jpeg", "webp"],
					"gpt-image-2": ["png", "jpeg", "webp"],
				},
				backgroundsByModel: {
					"gpt-image-1.5": ["transparent", "opaque", "auto"],
					"gpt-image-2": ["opaque", "auto"],
				},
			},
		},
		isConfigured(ctx) {
			return (
				Boolean(resolveConnection(configDir).apiKey) ||
				[providerId, ...aliases].some((provider) => isProviderApiKeyConfigured({ provider, ...ctx }))
			);
		},
		async generateImage(req: ImageRequest) {
			if (!req.model?.trim() || !req.prompt?.trim()) {
				throw new ImageGenerationError("INVALID_IMAGE_REQUEST", "Image model and prompt are required");
			}
			if ((req.count ?? 1) !== 1 || (req.inputImages?.length ?? 0) > 1) {
				throw new ImageGenerationError(
					"INVALID_IMAGE_REQUEST",
					"Only one output image and one reference image are supported per request",
				);
			}
			const timeoutMs = req.timeoutMs ?? IMAGE_TIMEOUT_MS;
			if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
				throw new ImageGenerationError("INVALID_IMAGE_REQUEST", "Invalid image request timeout");
			}
			// One deadline covers authentication, generation, body reading, and asset download.
			const signal = AbortSignal.timeout(timeoutMs);
			const conn = resolveConnection(configDir);
			let apiKey = conn.apiKey;
			if (!apiKey) {
				// Resolve the requested alias first so alias-specific provider config remains valid.
				const { resolveApiKeyForProvider } = await import("openclaw/plugin-sdk/agent-runtime");
				const supportedIds = new Set([providerId, ...aliases]);
				const requestedId = supportedIds.has(req.provider) ? req.provider : providerId;
				const authProviderIds = [...new Set([requestedId, providerId, ...aliases])];
				let missingAuthError: unknown;
				for (const provider of authProviderIds) {
					try {
						const auth = await resolveApiKeyForProvider({
							provider,
							cfg: req.cfg,
							agentDir: req.agentDir,
							store: req.authStore,
							secretSentinels: false,
						});
						apiKey = auth.apiKey;
						break;
					} catch (error) {
						if (!(error instanceof Error) || !("code" in error) || error.code !== "missing-provider-auth") {
							throw error;
						}
						missingAuthError = error;
					}
				}
				if (!apiKey && missingAuthError) throw missingAuthError;
			}
			if (!apiKey) throw new ImageGenerationError("MISSING_API_KEY", "CLIProxyAPI API key is required");
			signal.throwIfAborted();

			const fields: Record<string, string> = {
				model: req.model.trim(),
				prompt: req.prompt,
				response_format: "b64_json",
			};
			if (req.size) fields.size = req.size;
			if (req.quality) fields.quality = req.quality;
			if (req.outputFormat) fields.output_format = req.outputFormat;
			if (req.background) fields.background = req.background;
			const input = req.inputImages?.[0];
			let body: string | FormData;
			const headers = new Headers({ Authorization: `Bearer ${apiKey}` });
			if (input) {
				if (
					!input.buffer.length ||
					input.buffer.length > IMAGE_MAX_BYTES ||
					!IMAGE_MIME_TYPES.has(input.mimeType)
				) {
					throw new ImageGenerationError(
						"INVALID_IMAGE_REQUEST",
						"Reference image must be PNG, JPEG, or WebP and at most 20 MiB",
					);
				}
				const form = new FormData();
				for (const [key, value] of Object.entries(fields)) form.set(key, value);
				form.set("n", "1");
				form.set("stream", "false");
				form.set(
					"image",
					new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }),
					`reference.${extensionForMime(input.mimeType)}`,
				);
				body = form;
			} else {
				headers.set("Content-Type", "application/json");
				body = JSON.stringify({ ...fields, n: 1, stream: false });
			}

			const policy: SsrFPolicy | undefined = req.ssrfPolicy ?? req.cfg.browser?.ssrfPolicy;
			const { response, release } = await fetchWithSsrFGuard({
				url: `${conn.inferenceBaseUrl}/images/${input ? "edits" : "generations"}`,
				init: { method: "POST", headers, body },
				policy,
				signal,
				maxRedirects: 0,
				capture: false,
			});
			let payload: unknown;
			try {
				if (!response.ok) {
					// Never reflect a backend error body, which may contain keys or prompts.
					throw new ImageGenerationError(
						"IMAGE_HTTP_ERROR",
						`CLIProxyAPI image request failed (HTTP ${response.status})`,
						response.status,
					);
				}
				const json = (await readResponseWithLimit(response, IMAGE_JSON_MAX_BYTES)).toString("utf8");
				try {
					payload = JSON.parse(json);
				} catch (error) {
					// Translate syntax failures at the HTTP boundary without reflecting response snippets.
					if (!(error instanceof SyntaxError)) throw error;
					throw new ImageGenerationError("INVALID_IMAGE_RESPONSE", "CLIProxyAPI returned invalid image JSON");
				}
			} finally {
				await release();
			}
			if (
				!payload ||
				typeof payload !== "object" ||
				!("data" in payload) ||
				!Array.isArray(payload.data) ||
				payload.data.length !== 1
			) {
				throw new ImageGenerationError("INVALID_IMAGE_RESPONSE", "Expected exactly one generated image");
			}
			const entry: unknown = payload.data[0];
			if (!entry || typeof entry !== "object") {
				throw new ImageGenerationError("INVALID_IMAGE_RESPONSE", "Invalid image response entry");
			}
			let buffer: Buffer;
			if ("b64_json" in entry) {
				buffer = decodeImageBase64(entry.b64_json);
			} else if ("url" in entry && typeof entry.url === "string") {
				if (entry.url.startsWith("data:")) {
					const match = /^data:image\/(?:png|jpeg|webp);base64,(.+)$/.exec(entry.url);
					if (!match) throw new ImageGenerationError("INVALID_IMAGE_DATA", "Invalid inline image URL");
					buffer = decodeImageBase64(match[1]);
				} else {
					const url = new URL(entry.url);
					if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
						throw new ImageGenerationError("INVALID_IMAGE_URL", "Invalid generated image URL");
					}
					// Foreign asset URLs receive neither credentials nor CPA's private-network opt-in.
					const download = await fetchWithSsrFGuard({
						url: url.href,
						policy:
							url.origin === new URL(conn.inferenceBaseUrl).origin
								? policy
								: {
										hostnameAllowlist: policy?.hostnameAllowlist,
										blockedHostnames: policy?.blockedHostnames,
									},
						signal,
						maxRedirects: 0,
						capture: false,
					});
					try {
						if (!download.response.ok) {
							throw new ImageGenerationError(
								"IMAGE_DOWNLOAD_ERROR",
								`Image download failed (HTTP ${download.response.status})`,
								download.response.status,
							);
						}
						buffer = await readResponseWithLimit(download.response, IMAGE_MAX_BYTES);
					} finally {
						await download.release();
					}
				}
			} else {
				throw new ImageGenerationError("INVALID_IMAGE_RESPONSE", "Image response has no image data");
			}
			signal.throwIfAborted();
			const mimeType = await detectMime({ buffer });
			signal.throwIfAborted();
			if (!buffer.length || !mimeType || !IMAGE_MIME_TYPES.has(mimeType)) {
				throw new ImageGenerationError("INVALID_IMAGE_DATA", "Response is not a PNG, JPEG, or WebP image");
			}
			return {
				model: req.model,
				images: [
					{
						buffer,
						mimeType,
						fileName: `cpa-image.${extensionForMime(mimeType)}`,
						...("revised_prompt" in entry && typeof entry.revised_prompt === "string"
							? { revisedPrompt: entry.revised_prompt }
							: {}),
					},
				],
			};
		},
	};
}
