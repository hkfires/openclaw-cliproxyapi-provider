import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { expect, it, vi } from "vitest";
import plugin from "../src/index.js";

it("registers canonical provider and cpa with executable host auth methods", () => {
	const registerProvider = vi.fn();
	const registerImageGenerationProvider = vi.fn();
	plugin.register({
		registerProvider,
		registerImageGenerationProvider,
		registerService: vi.fn(),
		runtime: { gateway: { request: vi.fn() } },
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as OpenClawPluginApi);
	expect(registerProvider.mock.calls.map(([p]) => p.id)).toEqual(["cliproxyapi", "cpa"]);
	expect(registerImageGenerationProvider).toHaveBeenCalledOnce();
	const imageProvider = registerImageGenerationProvider.mock.calls[0][0];
	expect(imageProvider.id).toBe("cliproxyapi");
	expect(imageProvider.aliases).toEqual(["cpa"]);
	expect(imageProvider.defaultModel).toBeUndefined();
	expect(typeof imageProvider.generateImage).toBe("function");
	expect(imageProvider.capabilities.edit.enabled).toBe(true);
	for (const [p] of registerProvider.mock.calls) {
		expect(p.auth[0].id).toBe("api-key");
		expect(typeof p.auth[0].run).toBe("function");
	}
});
