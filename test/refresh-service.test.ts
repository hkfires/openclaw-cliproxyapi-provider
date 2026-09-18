import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/core";
import { afterEach, expect, it, vi } from "vitest";
import { createRefreshService, resolveRefreshInterval } from "../src/refresh-service.js";

afterEach(() => vi.useRealTimers());
function fixture(seconds = 30) {
	vi.useFakeTimers();
	const request = vi.fn().mockResolvedValue({});
	const service = createRefreshService(["cliproxyapi", "cpa"], request);
	const ctx = {
		config: { plugins: { entries: { cliproxyapi: { config: { refreshIntervalSeconds: seconds } } } } },
		stateDir: "/tmp",
		logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
	} satisfies OpenClawPluginServiceContext;
	return { service, request, ctx };
}
it("validates intervals and defaults to thirty minutes", () => {
	expect(resolveRefreshInterval(undefined)).toBe(1800000);
	expect(resolveRefreshInterval(0)).toBe(0);
	for (const value of [-1, 1, 29, 1.5, "300", 86401, NaN]) expect(() => resolveRefreshInterval(value)).toThrow();
});
it("refreshes the host catalog periodically and stops cleanly", async () => {
	const { service, request, ctx } = fixture();
	service.start(ctx);
	await vi.advanceTimersByTimeAsync(29999);
	expect(request).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(request).toHaveBeenCalledTimes(2);
	expect(request).toHaveBeenCalledWith(
		process.execPath,
		expect.arrayContaining(["models", "list", "--refresh", "--provider", "cliproxyapi"]),
		expect.objectContaining({ timeout: 240000, signal: expect.any(AbortSignal) }),
	);
	await vi.advanceTimersByTimeAsync(30000);
	expect(request).toHaveBeenCalledTimes(4);
	service.stop!(ctx);
	await vi.advanceTimersByTimeAsync(90000);
	expect(request).toHaveBeenCalledTimes(4);
});
it("does not overlap requests, and stop prevents alias dispatch and rescheduling", async () => {
	const { service, request, ctx } = fixture();
	let finish!: () => void;
	request.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	service.start(ctx);
	await vi.advanceTimersByTimeAsync(30000);
	await vi.advanceTimersByTimeAsync(90000);
	expect(request).toHaveBeenCalledTimes(1);
	const signal = request.mock.calls[0][2].signal as AbortSignal;
	expect(signal.aborted).toBe(false);
	service.stop!(ctx);
	expect(signal.aborted).toBe(true);
	finish();
	await vi.advanceTimersByTimeAsync(90000);
	expect(request).toHaveBeenCalledTimes(1);
	expect(vi.getTimerCount()).toBe(0);
});
it("retries after failures without logging their contents", async () => {
	const { service, request, ctx } = fixture();
	request.mockRejectedValueOnce(new Error("secret"));
	service.start(ctx);
	await vi.advanceTimersByTimeAsync(30000);
	expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(ctx.logger.warn.mock.calls)).not.toContain("secret");
	await vi.advanceTimersByTimeAsync(30000);
	expect(request).toHaveBeenCalledTimes(4);
	service.stop!(ctx);
});
it("supports disabling and updated configuration on service restart", async () => {
	const { service, request, ctx } = fixture(0);
	service.start(ctx);
	await vi.advanceTimersByTimeAsync(600000);
	expect(request).not.toHaveBeenCalled();
	ctx.config.plugins.entries.cliproxyapi.config.refreshIntervalSeconds = 30;
	service.start(ctx);
	await vi.advanceTimersByTimeAsync(30000);
	expect(request).toHaveBeenCalledTimes(2);
	service.stop!(ctx);
});
