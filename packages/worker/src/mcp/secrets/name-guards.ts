const skillRunnerSecretNamePrefix = 'skill-runner-token:'

function parseSkillRunnerSecretClientName(secretName: string) {
	if (!secretName.startsWith(skillRunnerSecretNamePrefix)) return null
	const clientName = secretName.slice(skillRunnerSecretNamePrefix.length).trim()
	return clientName || null
}

export function isReservedSecretName(name: string) {
	return parseSkillRunnerSecretClientName(name.trim()) != null
}

export function assertSecretNameAllowed(name: string) {
	if (isReservedSecretName(name)) {
		throw new Error('Secret name is reserved for internal use.')
	}
}
