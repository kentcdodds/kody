/**
 * Shared admin feature-flag shape used by the worker service and client
 * loader/route types. Kept dependency-free so the client tsconfig can include
 * it without pulling in D1-typed modules.
 */
export type AdminFeatureFlag = {
	key: string
	description: string | null
	defaultEnabled: boolean | null
	stale: boolean
	global: {
		enabled: boolean
		rolloutPercent: number | null
		note: string
		updatedBy: number | null
		updatedAt: string
	} | null
	overrides: Array<{
		userId: number
		username: string
		enabled: boolean
		updatedAt: string
	}>
}
