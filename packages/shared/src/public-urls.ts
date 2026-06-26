export function buildUsernamePathPrefix(username: string) {
	return `/@${encodeURIComponent(username.trim())}`
}

export function buildPackageAppPath(input: {
	username: string
	kodyId: string
	restPath?: string | null
}) {
	const restPath = input.restPath?.trim()
	const suffix = restPath ? `/${restPath.replace(/^\/+/, '')}` : ''
	return `${buildUsernamePathPrefix(input.username)}/packages/${encodeURIComponent(
		input.kodyId.trim(),
	)}${suffix}`
}

export function buildPackageAppUrl(input: {
	origin: string
	username: string
	kodyId: string
	restPath?: string | null
}) {
	return `${input.origin.trim().replace(/\/+$/, '')}${buildPackageAppPath(input)}`
}

export const packageInvocationRootExportRouteSegment = '__root__'

export function normalizePackageInvocationExportName(exportName: string) {
	const trimmed = exportName.trim()
	if (!trimmed) {
		throw new Error('Package export name must not be empty.')
	}
	if (trimmed === '.' || trimmed === './') {
		return '.'
	}
	return trimmed.startsWith('./') ? trimmed : `./${trimmed}`
}

export function buildPackageInvocationRouteExportName(exportName: string) {
	const normalized = normalizePackageInvocationExportName(exportName)
	if (normalized === '.') return packageInvocationRootExportRouteSegment
	return normalized.startsWith('./') ? normalized.slice(2) : normalized
}

export function buildPackageInvocationPath(input: {
	username: string
	kodyId: string
	exportName: string
}) {
	return `${buildUsernamePathPrefix(input.username)}/api/package-invocations/${encodeURIComponent(
		input.kodyId.trim(),
	)}/${encodeURIComponent(buildPackageInvocationRouteExportName(input.exportName))}`
}

export function buildPackageInvocationUrl(input: {
	origin: string
	username: string
	kodyId: string
	exportName: string
}) {
	return `${input.origin.trim().replace(/\/+$/, '')}${buildPackageInvocationPath(input)}`
}

export function requireUsernameForPublicUrl(
	username: string | null | undefined,
) {
	if (!username) {
		throw new Error(
			'Username is required to build username-scoped public URLs.',
		)
	}
	return username
}
