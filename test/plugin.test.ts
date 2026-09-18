import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { expect, it, vi } from "vitest";
import plugin from "../src/index.js";

it("registers canonical provider with cpa alias and executable host auth methods", () => {
	const registerProvider = vi.fn();
	const registerImageGenerationProvider = vi.fn();
	plugin.register({
		registerProvider,
		registerImageGenerationProvider,
		registerService: vi.fn(),
		runtime: { gateway: { request: vi.fn() } },
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as OpenClawPluginApi);
	expect(registerProvider).toHaveBeenCalledOnce();
	const chatProvider = registerProvider.mock.calls[0][0];
	expect(chatProvider.id).toBe("cliproxyapi");
	expect(chatProvider.aliases).toEqual(["cpa"]);
	expect(registerImageGenerationProvider).toHaveBeenCalledOnce();
	const imageProvider = registerImageGenerationProvider.mock.calls[0][0];
	expect(imageProvider.id).toBe("cliproxyapi");
	expect(imageProvider.aliases).toEqual(["cpa"]);
	expect(imageProvider.defaultModel).toBeUndefined();
	expect(typeof imageProvider.generateImage).toBe("function");
	expect(imageProvider.capabilities.edit.enabled).toBe(true);
	expect(chatProvider.auth[0].id).toBe("api-key");
	expect(typeof chatProvider.auth[0].run).toBe("function");
});
