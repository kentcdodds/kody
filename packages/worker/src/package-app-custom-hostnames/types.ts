export const packageAppCustomHostnameBindingKinds = ['app', 'org'] as const

export type PackageAppCustomHostnameBindingKind =
	(typeof packageAppCustomHostnameBindingKinds)[number]

/** Row shape for `package_app_custom_hostnames`. Hostname is stored lowercased. */
export type PackageAppCustomHostnameRow = {
	id: string
	hostname: string
	bindingKind: PackageAppCustomHostnameBindingKind
	packageId: string | null
	orgId: string | null
	cloudflareHostnameId: string | null
	cloudflareZoneId: string | null
	hostnameStatus: string
	sslStatus: string
	verifiedAt: string | null
	dnsMissingSince: string | null
	createdByUserId: string | null
	createdAt: string
	updatedAt: string
}

/**
 * Resolved custom hostname. App bindings include the package owner handle and
 * the package name leaf (`kodyId`). Org bindings are stored for a later tier
 * and are not served.
 */
export type PackageAppCustomHostnameLookup = {
	hostname: string
	bindingKind: PackageAppCustomHostnameBindingKind
	packageId: string | null
	orgId: string | null
	username: string | null
	kodyId: string | null
	hostnameStatus: string
	sslStatus: string
	verified: boolean
}

export type VerifiedAppCustomHostname = PackageAppCustomHostnameLookup & {
	bindingKind: 'app'
	packageId: string
	username: string
	kodyId: string
	verified: true
}
