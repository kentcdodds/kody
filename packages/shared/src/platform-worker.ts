/**
 * Cross-worker contract for the platform Durable Object Worker
 * (`packages/platform-worker`, script `kody-platform`).
 *
 * The origin `kody` Worker and `kody-runtime` reach platform-owned Durable
 * Objects through cross-script bindings, not RPC. The only structured HTTP
 * endpoint is the deploy healthcheck below.
 */

/** Healthcheck endpoint served by the platform Worker. */
export const platformWorkerHealthPath = '/__platform/health'

export type PlatformWorkerHealth = {
	status: 'ok'
	commitSha: string | null
	cookieSecretConfigured: boolean
}

export function buildPlatformWorkerHealth(input: {
	commitSha: string | undefined
	cookieSecretConfigured: boolean
}): PlatformWorkerHealth {
	const trimmed = input.commitSha?.trim()
	return {
		status: 'ok',
		commitSha: trimmed ? trimmed : null,
		cookieSecretConfigured: input.cookieSecretConfigured,
	}
}
