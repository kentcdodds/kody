export function buildSecretProviderPackageApprovalUrl(input: {
	baseUrl: string
	providerId: string
	canonicalRef: string
	packageId: string
	kodyId: string | null
}) {
	const url = new URL('/account/secret-providers/approve', input.baseUrl)
	url.searchParams.set('provider', input.providerId)
	url.searchParams.set('ref', input.canonicalRef)
	url.searchParams.set('package_id', input.packageId)
	if (input.kodyId) {
		url.searchParams.set('package', input.kodyId)
	}
	return url.toString()
}

export function buildSecretProviderUsageUrl(input: { baseUrl: string }) {
	return new URL('/account/secret-providers', input.baseUrl).toString()
}
