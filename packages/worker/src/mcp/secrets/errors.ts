const hostApprovalRequiredRegex =
	/^Secret "([^"]+)" is not allowed for host "([^"]+)"/
const missingSecretRegex = /^Secret "([^"]+)" was not found\.$/

export const fetchSecretAuthRequiredMessage =
	'Network requests that use secret placeholders require an authenticated user.'

export const capabilityInputSecretAuthRequiredMessage =
	'Capability inputs that use secret placeholders require an authenticated user.'

const secretAuthRequiredMessages = new Set([
	fetchSecretAuthRequiredMessage,
	capabilityInputSecretAuthRequiredMessage,
])

export function createMissingSecretMessage(secretName: string) {
	return `Secret "${secretName}" was not found.`
}

export function parseMissingSecretMessage(message: string) {
	const match = message.match(missingSecretRegex)
	if (!match?.[1]) return null
	return {
		secretName: match[1],
	}
}

export function parseHostApprovalRequiredMessage(message: string) {
	const match = message.match(hostApprovalRequiredRegex)
	if (!match?.[1] || !match?.[2]) return null
	return {
		secretName: match[1],
		host: match[2],
	}
}

export function isSecretAuthRequiredMessage(message: string) {
	return secretAuthRequiredMessages.has(message)
}
