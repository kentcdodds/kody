import { type SecretScope } from './types.ts'

const hostApprovalRequiredRegex =
	/^Secret "([^"]+)" is not allowed for host "([^"]+)"/
const packageAccessRequiredRegex =
	/^Secret "([^"]+)" is not allowed for package "([^"]+)"/
const hostBatchDeniedPrefix = 'Secrets require host approval:'
const packageBatchDeniedPrefix = 'Secrets require package approval:'
const missingSecretRegex = /^Secret "([^"]+)" was not found\.$/
const secretScopeUnavailableRegex =
	/^Secret "([^"]+)" exists in (session|package|user) scope(?: for package( id)? "([^"]+)")?/

export const fetchSecretAuthRequiredMessage =
	'Network requests that use secret placeholders require an authenticated user.'

const secretAuthRequiredMessages = new Set([fetchSecretAuthRequiredMessage])

export function createMissingSecretMessage(secretName: string) {
	return `Secret "${secretName}" was not found.`
}

export type SecretScopeUnavailableMatch = {
	secretName: string
	scope: SecretScope
	packageId: string | null
	packageName: string | null
	sessionId: string | null
	editorUrl: string | null
}

function describeSecretScopeLocation(match: SecretScopeUnavailableMatch) {
	switch (match.scope) {
		case 'package':
			if (match.packageName) {
				return `package scope for package "${match.packageName}"`
			}
			if (match.packageId) {
				return `package scope for package id "${match.packageId}"`
			}
			return 'package scope'
		case 'session':
			return 'session scope'
		case 'user':
			return 'user scope'
		default: {
			const _exhaustive: never = match.scope
			return _exhaustive
		}
	}
}

export function createSecretScopeUnavailableMessage(
	matches: Array<SecretScopeUnavailableMatch>,
) {
	const [first, ...rest] = matches
	if (!first) {
		throw new Error('At least one secret scope match is required.')
	}
	const extra =
		rest.length === 0
			? ''
			: ` It also exists in ${rest.map(describeSecretScopeLocation).join(', ')}.`
	const hasPackageMatch = matches.some((match) => match.scope === 'package')
	const guidance = hasPackageMatch
		? " Package-scoped secrets are only available while that package runs. Either invoke this work through the owning package, or ask the user to change the secret's scope in the account secrets UI."
		: " Ask the user to change the secret's scope in the account secrets UI, or retry from a runtime that can see this scope."
	const editorUrl = matches.find((match) => match.editorUrl)?.editorUrl ?? null
	const editorSuffix = editorUrl ? ` Editor link: ${editorUrl}` : ''
	return `Secret "${first.secretName}" exists in ${describeSecretScopeLocation(first)} and is not visible from this runtime.${extra}${guidance}${editorSuffix}`
}

export type HostApprovalEntry = {
	secretName: string
	host: string
	approvalUrl: string
}

export type PackageApprovalEntry = {
	secretName: string
	packageId: string
	kodyId: string | null
	packageName: string | null
	approvalUrl: string
}

export function createHostSecretAccessDeniedBatchMessage(
	entries: Array<HostApprovalEntry>,
	options: { bulkApprovalUrl?: string | null } = {},
) {
	const bulkApprovalUrl = options.bulkApprovalUrl?.trim() || null
	const payload = JSON.stringify({
		entries,
		...(bulkApprovalUrl ? { bulkApprovalUrl } : {}),
	})
	return `${hostBatchDeniedPrefix} ${payload}`
}

export function createPackageSecretAccessDeniedMessage(input: {
	secretName: string
	packageName: string
	approvalUrl?: string | null
}) {
	const approvalSuffix = input.approvalUrl
		? ` Approval link: ${input.approvalUrl}`
		: ''
	return `Secret "${input.secretName}" is not allowed for package "${input.packageName}". If this package should be able to use the secret, ask the user whether to approve that package in the account secrets UI, then retry after they approve that policy change.${approvalSuffix}`
}

export function createPackageSecretAccessDeniedBatchMessage(
	entries: Array<PackageApprovalEntry>,
	options: { bulkApprovalUrl?: string | null } = {},
) {
	const bulkApprovalUrl = options.bulkApprovalUrl?.trim() || null
	const payload = JSON.stringify({
		entries,
		...(bulkApprovalUrl ? { bulkApprovalUrl } : {}),
	})
	return `${packageBatchDeniedPrefix} ${payload}`
}

function parseHostApprovalEntries(value: unknown) {
	if (!Array.isArray(value)) return []
	const entries: Array<HostApprovalEntry> = []
	for (const entry of value) {
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
	return entries
}

export function parseHostApprovalRequiredBatchMessage(message: string): {
	entries: Array<HostApprovalEntry>
	bulkApprovalUrl: string | null
} | null {
	if (!message.startsWith(hostBatchDeniedPrefix)) return null
	const raw = message.slice(hostBatchDeniedPrefix.length).trim()
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw)
		if (Array.isArray(parsed)) {
			const entries = parseHostApprovalEntries(parsed)
			return entries.length > 0 ? { entries, bulkApprovalUrl: null } : null
		}
		if (!parsed || typeof parsed !== 'object') return null
		const entries = parseHostApprovalEntries(
			'entries' in parsed ? parsed.entries : null,
		)
		if (entries.length === 0) return null
		const bulkApprovalUrl =
			'bulkApprovalUrl' in parsed &&
			typeof parsed.bulkApprovalUrl === 'string' &&
			parsed.bulkApprovalUrl.trim()
				? parsed.bulkApprovalUrl.trim()
				: null
		return { entries, bulkApprovalUrl }
	} catch {
		return null
	}
}

function parsePackageApprovalEntries(value: unknown) {
	if (!Array.isArray(value)) return []
	const entries: Array<PackageApprovalEntry> = []
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') continue
		if (
			typeof entry.secretName !== 'string' ||
			typeof entry.packageId !== 'string' ||
			typeof entry.approvalUrl !== 'string'
		) {
			continue
		}
		entries.push({
			secretName: entry.secretName,
			packageId: entry.packageId,
			kodyId: typeof entry.kodyId === 'string' ? entry.kodyId : null,
			packageName:
				typeof entry.packageName === 'string' ? entry.packageName : null,
			approvalUrl: entry.approvalUrl,
		})
	}
	return entries
}

export function parsePackageAccessRequiredBatchMessage(message: string): {
	entries: Array<PackageApprovalEntry>
	bulkApprovalUrl: string | null
} | null {
	if (!message.startsWith(packageBatchDeniedPrefix)) return null
	const raw = message.slice(packageBatchDeniedPrefix.length).trim()
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw)
		if (Array.isArray(parsed)) {
			const entries = parsePackageApprovalEntries(parsed)
			return entries.length > 0 ? { entries, bulkApprovalUrl: null } : null
		}
		if (!parsed || typeof parsed !== 'object') return null
		const entries = parsePackageApprovalEntries(
			'entries' in parsed ? parsed.entries : null,
		)
		if (entries.length === 0) return null
		const bulkApprovalUrl =
			'bulkApprovalUrl' in parsed &&
			typeof parsed.bulkApprovalUrl === 'string' &&
			parsed.bulkApprovalUrl.trim()
				? parsed.bulkApprovalUrl.trim()
				: null
		return { entries, bulkApprovalUrl }
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

function parseSecretErrorScope(value: string): SecretScope | null {
	switch (value) {
		case 'session':
		case 'package':
		case 'user':
			return value
		default:
			return null
	}
}

export function parseSecretScopeUnavailableMessage(message: string) {
	const match = message.match(secretScopeUnavailableRegex)
	if (!match?.[1] || !match[2]) return null
	const scope = parseSecretErrorScope(match[2])
	if (!scope) return null
	const label = match[4] ?? null
	const usesPackageId = Boolean(match[3])
	return {
		secretName: match[1],
		scope,
		packageName: usesPackageId ? null : label,
		packageId: usesPackageId ? label : null,
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

export function parsePackageAccessRequiredMessage(message: string) {
	const match = message.match(packageAccessRequiredRegex)
	if (!match?.[1] || !match?.[2]) return null
	return {
		secretName: match[1],
		packageName: match[2],
	}
}

export function isSecretAuthRequiredMessage(message: string) {
	return secretAuthRequiredMessages.has(message)
}
