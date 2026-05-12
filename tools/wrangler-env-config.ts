import path from 'node:path'

export const defaultWranglerConfigPath = 'packages/worker/wrangler.jsonc'

export function getDefaultWranglerConfigPath(
	env: Partial<Pick<NodeJS.ProcessEnv, 'WRANGLER_CONFIG'>> = process.env,
) {
	const configuredPath = env.WRANGLER_CONFIG?.trim()
	return configuredPath || defaultWranglerConfigPath
}

export function resolveWranglerConfigPath(configPath: string, cwd: string) {
	return path.isAbsolute(configPath) ? configPath : path.join(cwd, configPath)
}
