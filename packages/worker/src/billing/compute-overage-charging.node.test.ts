import { expect, test } from 'vitest'
import { computeRolloutBucket } from '#worker/feature-flags/service.ts'
import { isComputeOverageChargingEnabled } from './compute-overage-charging.ts'

function createChargingFlagDb(input: {
	enabled?: number
	rolloutPercent?: number | null
	overrideEnabled?: boolean
}) {
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind() {
					return this
				},
				async first<T>() {
					if (normalized.includes('from feature_flag_user_overrides')) {
						if (input.overrideEnabled === true) {
							return { enabled: 1 } as T
						}
						if (input.overrideEnabled === false) {
							return { enabled: 0 } as T
						}
						return null
					}
					if (normalized.includes('from feature_flags')) {
						if (input.enabled === undefined) return null
						return {
							enabled: input.enabled,
							rollout_percent: input.rolloutPercent ?? null,
						} as T
					}
					return null
				},
			}
		},
	} as unknown as D1Database
}

test('global off is a hard gate even with a per-user on override', async () => {
	const db = createChargingFlagDb({
		enabled: 0,
		overrideEnabled: true,
	})
	await expect(isComputeOverageChargingEnabled(db, 9)).resolves.toBe(false)
})

test('a percentage rollout does not disable charging for in-bucket users', async () => {
	const db = createChargingFlagDb({
		enabled: 1,
		rolloutPercent: 50,
	})
	let inBucket = 1
	let outBucket = 2
	for (let candidate = 1; candidate < 10_000; candidate += 1) {
		if (computeRolloutBucket('compute-overage-charging', candidate) < 50) {
			inBucket = candidate
			break
		}
	}
	for (let candidate = 1; candidate < 10_000; candidate += 1) {
		if (computeRolloutBucket('compute-overage-charging', candidate) >= 50) {
			outBucket = candidate
			break
		}
	}
	await expect(isComputeOverageChargingEnabled(db, null)).resolves.toBe(true)
	await expect(isComputeOverageChargingEnabled(db, inBucket)).resolves.toBe(
		true,
	)
	await expect(isComputeOverageChargingEnabled(db, outBucket)).resolves.toBe(
		false,
	)
})
