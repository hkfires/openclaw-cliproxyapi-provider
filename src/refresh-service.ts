import { type ExecFileOptions, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/core";

export const DEFAULT_REFRESH_INTERVAL_SECONDS = 1800;

export function resolveRefreshInterval(value: unknown): number {
	const seconds = value ?? DEFAULT_REFRESH_INTERVAL_SECONDS;
	if (
		typeof seconds !== "number" ||
		!Number.isInteger(seconds) ||
		seconds < 0 ||
		seconds > 86400 ||
		(seconds > 0 && seconds < 30)
	) {
		throw new Error("refreshIntervalSeconds must be 0 (disabled) or an integer between 30 and 86400.");
	}
	return seconds * 1000;
}

/** Use the authenticated public CLI; in-process Gateway requests are official-plugin-only. */
export function createRefreshService(
	providerIds: string[],
	execute: (file: string, args: string[], options: ExecFileOptions) => Promise<unknown> = promisify(execFile),
): OpenClawPluginService {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;
	let pending: Promise<void> = Promise.resolve();
	return {
		id: "cliproxyapi-model-refresh",
		reload: { configPrefixes: ["plugins.entries.cliproxyapi.config", "agents"] },
		start(ctx) {
			controller?.abort();
			if (timer) clearTimeout(timer);
			const current = new AbortController();
			controller = current;
			const intervalMs = resolveRefreshInterval(
				ctx.config.plugins?.entries?.cliproxyapi?.config?.refreshIntervalSeconds,
			);
			if (intervalMs === 0) return;
			const agentIds: (string | undefined)[] = ctx.config.agents?.list?.length
				? [...new Set(ctx.config.agents.list.map((agent) => agent.id))]
				: [undefined];
			const schedule = () => {
				if (current.signal.aborted) return;
				timer = setTimeout(() => {
					// Serialize across service restart cycles as well as normal timer ticks.
					pending = pending
						.then(async () => {
							for (const agentId of agentIds) {
								for (const provider of providerIds) {
									if (current.signal.aborted) return;
									try {
										await execute(
											process.execPath,
											[
												fileURLToPath(import.meta.resolve("openclaw/cli-entry")),
												"models",
												"list",
												"--refresh",
												"--all",
												"--provider",
												provider,
												"--json",
												...(agentId ? ["--agent", agentId] : []),
											],
											{
												signal: current.signal,
												timeout: 240000,
												maxBuffer: 16 * 1024 * 1024,
												windowsHide: true,
											},
										);
									} catch {
										if (!current.signal.aborted)
											ctx.logger.warn(
												`CLIProxyAPI scheduled model refresh failed (${provider}). Check gateway credentials; will retry in the next cycle.`,
											);
									}
								}
							}
						})
						.finally(schedule);
				}, intervalMs);
				timer.unref();
			};
			schedule();
		},
		stop() {
			controller?.abort();
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}
