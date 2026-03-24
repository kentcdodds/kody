const homeConnectorEnvPrefix = 'HOME_CONNECTOR_'

type EnvRecord = Record<string, string | undefined>

function hasEnvValue(value: string | undefined) {
	return typeof value === 'string' && value.trim().length > 0
}

export function getForwardedHomeConnectorEnv(env: EnvRecord) {
	const forwardedEnv: Record<string, string> = {}

	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith(homeConnectorEnvPrefix) || !hasEnvValue(value)) {
			continue
		}

		const forwardedKey = key.slice(homeConnectorEnvPrefix.length)
		if (
			forwardedKey.length === 0 ||
			forwardedKey === 'ID' ||
			forwardedKey === 'SHARED_SECRET'
		) {
			continue
		}

		forwardedEnv[forwardedKey] = value.trim()
	}

	return forwardedEnv
}
