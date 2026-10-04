/**
 * Build the focused owner-facing secret setup URL (`/connect/secret-set`).
 * Same query contract as the older `/account/secrets/new` agent links; session
 * auth and `POST /account/secrets.json` save permissions are unchanged.
 */
export function buildSecretSetupUrl(input: {
	baseUrl: string
	name: string
	description?: string
	expiresAt?: string
	allowedHosts?: Array<string>
	allowedPackages?: Array<string>
	scope?: 'user' | 'package'
	packageId?: string
}) {
	const name = input.name.trim()
	if (!name) {
		throw new Error('A secret name is required for the secret setup URL.')
	}
	const url = new URL('/connect/secret-set', input.baseUrl)
	url.searchParams.set('name', name)
	const description = input.description?.trim()
	if (description) url.searchParams.set('description', description)
	const expiresAt = input.expiresAt?.trim()
	if (expiresAt) url.searchParams.set('expiresAt', expiresAt)
	const hosts = (input.allowedHosts ?? [])
		.map((host) => host.trim())
		.filter(Boolean)
	if (hosts.length > 0) {
		url.searchParams.set('allowedHosts', hosts.join(','))
	}
	const packages = (input.allowedPackages ?? [])
		.map((packageId) => packageId.trim())
		.filter(Boolean)
	if (packages.length > 0) {
		url.searchParams.set('allowedPackages', packages.join(','))
	}
	const scope = input.scope
	if (scope === 'package' || scope === 'user') {
		url.searchParams.set('scope', scope)
	}
	const packageId = input.packageId?.trim()
	if (packageId) url.searchParams.set('packageId', packageId)
	return url.toString()
}
