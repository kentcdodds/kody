import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonc } from './ci/resource-utils.ts'

type JsonRecord = Record<string, unknown>

export const localOriginDevVarKeys = [
	'WRANGLER_IS_LOCAL_DEV',
	'CLOUDFLARE_API_BASE_URL',
	'CLOUDFLARE_API_TOKEN',
	'CLOUDFLARE_ACCOUNT_ID',
	'CLOUDFLARE_API_SOURCE_SNAPSHOTS',
	'APP_BASE_URL',
] as const

/**
 * Non-secret process-env values that used to be wrangler `--var`s on
 * `wrangler-env.ts dev`. Vite's Cloudflare plugin reads Worker bindings from
 * the Wrangler config, not from the Vite process environment, so these must
 * be written into `vars` for local `vite serve`. Secrets stay in
 * `packages/worker/.env` / `.dev.vars` next to the generated config.
 */
export function collectLocalOriginDevVars(
	env: NodeJS.ProcessEnv,
	port?: string,
) {
	const vars: Record<string, string> = {
		WRANGLER_IS_LOCAL_DEV: env.WRANGLER_IS_LOCAL_DEV?.trim() || 'true',
	}
	if (!env.APP_BASE_URL?.trim() && port) {
		vars.APP_BASE_URL = `http://localhost:${port}`
	}
	const skipLiveCloudflareToken = env.SKIP_CLOUDFLARE_MOCK?.trim() === '1'
	for (const key of localOriginDevVarKeys) {
		if (key === 'WRANGLER_IS_LOCAL_DEV') continue
		if (key === 'CLOUDFLARE_API_TOKEN' && skipLiveCloudflareToken) continue
		const value = env[key]?.trim()
		if (value) vars[key] = value
	}
	return vars
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' ? (value as JsonRecord) : {}
}

export async function writeLocalOriginDevConfig({
	originConfigPath,
	envName,
	vars,
}: {
	originConfigPath: string
	envName: string
	vars: Record<string, string>
}) {
	const sourceText = await readFile(originConfigPath, 'utf8')
	const config = parseJsonc<JsonRecord>(sourceText)
	const envs = config.env
	if (!envs || typeof envs !== 'object') {
		throw new Error(`${originConfigPath} is missing "env".`)
	}
	const originEnv = (envs as JsonRecord)[envName]
	if (!originEnv || typeof originEnv !== 'object') {
		throw new Error(`${originConfigPath} is missing "env.${envName}".`)
	}
	const envRecord = originEnv as JsonRecord
	envRecord.vars = {
		...asRecord(envRecord.vars),
		...vars,
	}
	config.vars = {
		...asRecord(config.vars),
		...vars,
	}

	const outputPath = path.join(
		path.dirname(originConfigPath),
		'wrangler-local-dev.generated.json',
	)
	await writeFile(outputPath, `${JSON.stringify(config, null, '\t')}\n`)
	return outputPath
}
