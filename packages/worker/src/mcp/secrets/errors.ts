const hostApprovalRequiredRegex =
	/^Secret "([^"]+)" is not allowed for host "([^"]+)"/
const capabilityAccessRequiredRegex =
	/^Secret "([^"]+)" is not allowed for capability "([^"]+)"/
const capabilityBatchDeniedPrefix = 'Secrets require capability approval:'
const hostBatchDeniedPrefix = 'Secrets require host approval:'
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

export function createCapabilitySecretAccessDeniedMessage(
	secretName: string,
	capabilityName: string,
	approvalUrl?: string | null,
) {
	const approvalSuffix = approvalUrl
		? ` Approval link: ${approvalUrl}`
		: ''
	return `Secret "${secretName}" is not allowed for capability "${capabilityName}". If this capability should be able to use the secret, ask the user whether to add "${capabilityName}" to the secret's allowed capabilities in the account secrets UI, then retry after they approve that policy change.${approvalSuffix}`
}

export type CapabilityApprovalEntry = {
	secretName: string
	capabilityName: string
	approvalUrl: string
}

export type HostApprovalEntry = {
	secretName: string
	host: string
	approvalUrl: string
}

export function createCapabilitySecretAccessDeniedBatchMessage(
	entries: Array<CapabilityApprovalEntry>,
) {
	const payload = JSON.stringify(entries)
	return `${capabilityBatchDeniedPrefix} ${payload}`
}

export function createHostSecretAccessDeniedBatchMessage(
	entries: Array<HostApprovalEntry>,
) {
	const payload = JSON.stringify(entries)
	return `${hostBatchDeniedPrefix} ${payload}`
}

export function parseCapabilityAccessRequiredBatchMessage(message: string) {
	if (!message.startsWith(capabilityBatchDeniedPrefix)) return null
	const raw = message.slice(capabilityBatchDeniedPrefix.length).trim()
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw)
		if (!Array.isArray(parsed)) return null
		const entries: Array<CapabilityApprovalEntry> = []
		for (const entry of parsed) {
			if (!entry || typeof entry !== 'object') continue
			if (
				typeof entry.secretName !== 'string' ||
				typeof entry.capabilityName !== 'string' ||
				typeof entry.approvalUrl !== 'string'
			) {
				continue
			}
			entries.push({
				secretName: entry.secretName,
				capabilityName: entry.capabilityName,
				approvalUrl: entry.approvalUrl,
			})
		}
		return entries.length > 0 ? entries : null
	} catch {
		return null
	}
}

export function parseHostApprovalRequiredBatchMessage(message: string) {
	if (!message.startsWith(hostBatchDeniedPrefix)) return null
	const raw = message.slice(hostBatchDeniedPrefix.length).trim()
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw)
		if (!Array.isArray(parsed)) return null
		const entries: Array<HostApprovalEntry> = []
		for (const entry of parsed) {
			if (!entry || typeof entry !== 'object') continue
			if (
				typeof entry.secretName !== 'string' ||
				typeof entry.host !== 'string' ||
				typeof entry.approvalUrl !== 'string'
			) {
				continue
			}
			entries.push({
				secretName: entry.secretName,
				host: entry.host,
				approvalUrl: entry.approvalUrl,
			})
		}
		return entries.length > 0 ? entries : null
	} catch {
		return null
	}
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

export function parseCapabilityAccessRequiredMessage(message: string) {
	const match = message.match(capabilityAccessRequiredRegex)
	if (!match?.[1] || !match?.[2]) return null
	return {
		secretName: match[1],
		capabilityName: match[2],
	}
}

export function isSecretAuthRequiredMessage(message: string) {
	return secretAuthRequiredMessages.has(message)
}
