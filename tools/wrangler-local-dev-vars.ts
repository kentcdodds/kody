const localDevEnvPassthroughKeys = [
	'AI_GATEWAY_ID',
	'AI_MODE',
	'AI_MODEL',
	'AI_MOCK_API_KEY',
	'AI_MOCK_BASE_URL',
	'APP_BASE_URL',
	'APP_COMMIT_SHA',
	'CAPABILITY_REINDEX_SECRET',
	'CLOUDFLARE_ACCOUNT_ID',
	'CLOUDFLARE_API_BASE_URL',
	'CLOUDFLARE_API_TOKEN',
	'CURSOR_API_BASE_URL',
	'CURSOR_API_KEY',
	'GITHUB_API_BASE_URL',
	'GITHUB_TOKEN',
	'HOME_CONNECTOR_SHARED_SECRET',
	'RESEND_API_BASE_URL',
	'RESEND_API_KEY',
	'RESEND_FROM_EMAIL',
	'SENTRY_DSN',
	'SENTRY_ENVIRONMENT',
	'SENTRY_TRACES_SAMPLE_RATE',
] as const

export function buildWranglerLocalDevVars({
	env,
	existingVarKeys,
}: {
	env: NodeJS.ProcessEnv
	existingVarKeys: ReadonlySet<string>
}) {
	const args: Array<string> = []
	for (const key of localDevEnvPassthroughKeys) {
		const value = env[key]
		if (typeof value !== 'string' || value.length === 0) continue
		if (existingVarKeys.has(key)) continue
		args.push('--var', `${key}:${value}`)
	}

	return args
}

export function collectLocalDevVars(
	env: NodeJS.ProcessEnv,
	existingVarKeys: ReadonlySet<string>,
) {
	const entries: Array<[string, string]> = []
	for (const key of localDevEnvPassthroughKeys) {
		const value = env[key]
		if (typeof value !== 'string' || value.length === 0) continue
		if (existingVarKeys.has(key)) continue
		entries.push([key, value])
	}
	return entries
}

export function getCliVarKeys(argumentList: ReadonlyArray<string>) {
	const keys = new Set<string>()

	for (let index = 0; index < argumentList.length; index += 1) {
		const arg = argumentList[index]
		if (!arg) continue

		const pair =
			arg === '--var'
				? argumentList[index + 1]
				: arg.startsWith('--var=')
					? arg.slice('--var='.length)
					: undefined
		if (!pair) continue

		const separatorIndex = pair.indexOf(':')
		if (separatorIndex <= 0) continue
		keys.add(pair.slice(0, separatorIndex))

		if (arg === '--var') {
			index += 1
		}
	}

	return keys
}
