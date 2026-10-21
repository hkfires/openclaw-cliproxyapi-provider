// Stage the built plugin like `openclaw plugins install`: package files plus a link to the host package.
// Loading the repo root instead exposes the dev host's bundled plugins as a second owner (OpenClaw >=2026.10).
import { cp, mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function stagePlugin(state) {
  const pluginDir = join(state, 'plugin');
  for (const entry of ['dist', 'package.json', 'openclaw.plugin.json']) {
    await cp(resolve(entry), join(pluginDir, entry), { recursive: true });
  }
  await mkdir(join(pluginDir, 'node_modules'), { recursive: true });
  await symlink(resolve('node_modules/openclaw'), join(pluginDir, 'node_modules', 'openclaw'), 'junction');
  return pluginDir;
}
