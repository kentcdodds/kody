import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

function resolveConfigEnvPath(workspaceRoot: string, configPath: string) {
	const resolvedConfigPath = path.resolve(workspaceRoot, configPath)
	return path.join(path.dirname(resolvedConfigPath), '.env')
}

export function syncDotenvForConfig(input: {
	workspaceRoot: string
	configPath: string | undefined
	logger?: Pick<Console, 'warn'>
}) {
	if (!input.configPath) return

	const rootEnvPath = path.join(input.workspaceRoot, '.env')
	if (!existsSync(rootEnvPath)) return

	const configEnvPath = resolveConfigEnvPath(
		input.workspaceRoot,
		input.configPath,
	)
	if (path.resolve(configEnvPath) === path.resolve(rootEnvPath)) {
		return
	}

	if (existsSync(configEnvPath)) {
		const rootEnv = readFileSync(rootEnvPath, 'utf8')
		const configEnv = readFileSync(configEnvPath, 'utf8')
		if (configEnv === rootEnv) {
			return
		}

		input.logger?.warn(
			`Skipping .env sync because "${configEnvPath}" already differs from the root .env.`,
		)
		return
	}

	copyFileSync(rootEnvPath, configEnvPath)
}
