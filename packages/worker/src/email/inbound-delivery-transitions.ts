export const inboundStorageLeaseMs = 5 * 60 * 1000
export const inboundReconciliationRetryMs = 15 * 60 * 1000
export const inboundOrphanVerificationMs = 60 * 60 * 1000
export const inboundEffectLeaseMs = 5 * 60 * 1000
export const inboundEffectRetryMs = 15 * 60 * 1000

export function inboundLeaseExpiredBefore(now: Date, leaseMs: number) {
	return new Date(now.getTime() - leaseMs).toISOString()
}

export function inboundRetryAt(now: Date, retryMs: number) {
	return new Date(now.getTime() + retryMs).toISOString()
}
