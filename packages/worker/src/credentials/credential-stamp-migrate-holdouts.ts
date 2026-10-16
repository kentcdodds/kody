/**
 * Packages the platform credential-stamp migration must leave alone
 * (issue #3836). Kent's holdouts stay on the long-term publish-gate path.
 */
export const credentialStampMigrateHoldouts = [
	'@kentcdodds/raycast',
	'@kentcdodds/oauth-integration-health',
] as const

export type CredentialStampMigrateHoldout =
	(typeof credentialStampMigrateHoldouts)[number]

const holdoutSet: ReadonlySet<string> = new Set(credentialStampMigrateHoldouts)

export function isCredentialStampMigrateHoldout(packageName: string): boolean {
	return holdoutSet.has(packageName)
}
