/**
 * Compatibility settings for dynamic Worker Loader isolates (execute sandbox and
 * package apps). Keep these aligned with `packages/worker/wrangler.jsonc`.
 */
export const dynamicWorkerCompatibilityDate = '2026-04-16'

export const dynamicWorkerCompatibilityFlags = [
	'nodejs_compat',
	'global_fetch_strictly_public',
] as const

export type DynamicWorkerCompatibilityOptions = {
	compatibilityDate: string
	compatibilityFlags: Array<string>
}

export function createDynamicWorkerCompatibilityOptions(): DynamicWorkerCompatibilityOptions {
	return {
		compatibilityDate: dynamicWorkerCompatibilityDate,
		compatibilityFlags: [...dynamicWorkerCompatibilityFlags],
	}
}
