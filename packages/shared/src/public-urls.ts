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
