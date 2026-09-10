export const packageShareStatuses = [
	'pending',
	'accepted',
	'revoked',
	'left',
] as const

export type PackageShareStatus = (typeof packageShareStatuses)[number]

export const packageShareTrustLevels = ['follow', 'pin'] as const

export type PackageShareTrustLevel = (typeof packageShareTrustLevels)[number]

export const defaultPackageShareTrustLevel: PackageShareTrustLevel = 'pin'

export type PackageShareGrantLoaderView = {
	id: string
	packageId: string
	status: PackageShareStatus
	role: 'use'
	trustLevel: PackageShareTrustLevel | null
	pinAhead: boolean
	approveChangesPath: string | null
	packagePath: string
	packageName: string
	packageKodyId: string
	ownerUsername: string
	inviteeEmail: string | null
	inviteeUsername: string | null
	granteeUsername: string | null
	acceptedPublishedCommit: string | null
	publishedCommit: string | null
}

export type PackageShareFileChange = {
	path: string
	change: 'added' | 'removed' | 'modified'
	accepted: string | null
	current: string | null
}
