type RemoteAiLocalDevEnv = Record<string, string | undefined> & {
	AI_MODE?: string
	AI_GATEWAY_ID?: string
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
}

function formatEnvVarList(keys: ReadonlyArray<string>) {
	if (keys.length === 1) return keys[0]!
	return `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`
}

function createMissingEnvMessage(keys: ReadonlyArray<string>) {
	const missingVariables = formatEnvVarList(keys)
	const verb = keys.length === 1 ? 'is' : 'are'
	const pronoun = keys.length === 1 ? 'it' : 'them'
	return `${missingVariables} ${verb} required when AI_MODE is "remote" in local dev. Add ${pronoun} to .env before starting \`bun run dev\`.`
}

export function getRemoteAiLocalDevCredentialsError(
	env: Pick<
		RemoteAiLocalDevEnv,
		'CLOUDFLARE_ACCOUNT_ID' | 'CLOUDFLARE_API_TOKEN'
	>,
) {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	const missingCredentials = [
		...(accountId ? [] : ['CLOUDFLARE_ACCOUNT_ID']),
		...(apiToken ? [] : ['CLOUDFLARE_API_TOKEN']),
	]

	if (missingCredentials.length === 0) return undefined
	return createMissingEnvMessage(missingCredentials)
}

export function getRemoteAiLocalDevStartupError(env: RemoteAiLocalDevEnv) {
	if (env.AI_MODE?.trim() !== 'remote') return undefined

	const gatewayId = env.AI_GATEWAY_ID?.trim()
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	const missingVariables = [
		...(gatewayId ? [] : ['AI_GATEWAY_ID']),
		...(accountId ? [] : ['CLOUDFLARE_ACCOUNT_ID']),
		...(apiToken ? [] : ['CLOUDFLARE_API_TOKEN']),
	]

	if (missingVariables.length === 0) return undefined
	return createMissingEnvMessage(missingVariables)
}
