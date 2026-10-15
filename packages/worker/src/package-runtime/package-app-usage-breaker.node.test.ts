import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
	BudgetLimitError,
	ComputeOverageLimitError,
	isBudgetLimitError,
	isComputeOverageLimitError,
} from '#worker/entitlements/errors.ts'
import {
	asyncCheckIntervalMs,
	gatePackageAppUsage,
	packageAppUsageBreakerCooldownMs,
	resetPackageAppUsageBreakerForTests,
} from './package-app-usage-breaker.ts'

const ownerId = ownerIdFromStored('org-1')
const start = 1_800_000_000_000

function computeDenial(current = 412) {
	return new ComputeOverageLimitError({
		resource: 'unique_worker_days',
		plan: 'pro',
		limit: 350,
		current,
		creditsStatus: 'add_credits',
	})
}

function budgetDenial() {
	return new BudgetLimitError({
		kind: 'user',
		orgSlug: 'acme',
		actorUsername: 'member',
		spentMicroUsd: 5_000_000,
		budgetMicroUsd: 5_000_000,
	})
}

function setup(options: { limitPercent?: number | string } = {}) {
	const store = new Map<string, string>()
	const kvOps: Array<string> = []
	let failReads = false
	const kv = {
		async get(key: string, type: 'json') {
			kvOps.push(`get ${key}`)
			if (failReads) throw new Error('KV unavailable')
			expect(type).toBe('json')
			const raw = store.get(key)
			return raw === undefined ? null : (JSON.parse(raw) as unknown)
		},
		async put(key: string, value: string) {
			kvOps.push(`put ${key}`)
			store.set(key, value)
		},
		async delete(key: string) {
			kvOps.push(`delete ${key}`)
			store.delete(key)
		},
	}
	const env = {
		BUNDLE_ARTIFACTS_KV: kv,
		PACKAGE_APP_USAGE_BREAKER_LIMIT_PERCENT: options.limitPercent,
	} as unknown as Env
	const deferred: Array<Promise<unknown>> = []
	const check = vi.fn<() => Promise<void>>(async () => {})
	return {
		store,
		kvOps,
		check,
		failKvReads() {
			failReads = true
		},
		gate(input: { now: number; actorId?: string | null }) {
			return gatePackageAppUsage({
				env,
				ownerId,
				actorId: input.actorId === undefined ? 'person-1' : input.actorId,
				check,
				waitUntil: (promise) => deferred.push(promise),
				now: input.now,
			})
		},
		async flush() {
			await Promise.all(deferred.splice(0))
		},
	}
}

beforeEach(() => {
	resetPackageAppUsageBreakerForTests()
})

afterEach(() => {
	vi.restoreAllMocks()
})

test('closed: serves before the usage check runs, then checks after the response', async () => {
	const t = setup()
	let releaseCheck = () => {}
	t.check.mockImplementation(
		() => new Promise<void>((resolve) => (releaseCheck = resolve)),
	)

	await expect(t.gate({ now: start })).resolves.toBeUndefined()
	expect(t.check).toHaveBeenCalledTimes(1)
	releaseCheck()
	await t.flush()
	expect(t.store.size).toBe(0)
	expect(t.kvOps).toEqual(['get package-app-usage-breaker:v1:org-1:person-1'])
})

test('closed: one async check per visitor per interval in an isolate', async () => {
	const t = setup()
	await t.gate({ now: start })
	await t.gate({ now: start + 1_000 })
	await t.gate({ now: start + 1_000, actorId: 'person-2' })
	await t.flush()
	expect(t.check).toHaveBeenCalledTimes(2)

	await t.gate({ now: start + asyncCheckIntervalMs })
	await t.flush()
	expect(t.check).toHaveBeenCalledTimes(3)
})

test('a denial after the response opens the breaker; later requests fail fast with the stored denial', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValueOnce(computeDenial())

	await expect(t.gate({ now: start })).resolves.toBeUndefined()
	await t.flush()
	const stored = JSON.parse(
		t.store.get('package-app-usage-breaker:v1:org-1:person-1') ?? 'null',
	) as { retryAt: number; denial: { kind: string } }
	expect(stored.retryAt).toBe(start + packageAppUsageBreakerCooldownMs)
	expect(stored.denial.kind).toBe('compute')

	t.check.mockClear()
	const refused = await t
		.gate({ now: start + 1_000 })
		.catch((error: unknown) => error)
	expect(isComputeOverageLimitError(refused)).toBe(true)
	expect((refused as ComputeOverageLimitError).details).toMatchObject({
		limit: 350,
		current: 412,
	})
	expect(t.check).not.toHaveBeenCalled()
})

test('open: another isolate reads the KV deny entry and refuses without running the check', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValueOnce(budgetDenial())
	await t.gate({ now: start })
	await t.flush()

	resetPackageAppUsageBreakerForTests()
	t.check.mockClear()
	const refused = await t
		.gate({ now: start + 10_000 })
		.catch((error: unknown) => error)
	expect(isBudgetLimitError(refused)).toBe(true)
	expect((refused as BudgetLimitError).details.orgSlug).toBe('acme')
	expect(t.check).not.toHaveBeenCalled()
})

test('half-open: after the cooldown one probe runs first; passing closes the breaker', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValueOnce(computeDenial())
	await t.gate({ now: start })
	await t.flush()
	t.check.mockClear()

	const afterCooldown = start + packageAppUsageBreakerCooldownMs
	await expect(t.gate({ now: afterCooldown })).resolves.toBeUndefined()
	expect(t.check).toHaveBeenCalledTimes(1)
	expect(t.store.size).toBe(0)
	expect(t.kvOps.at(-1)).toBe(
		'delete package-app-usage-breaker:v1:org-1:person-1',
	)
})

test('half-open: a failing probe refuses and re-opens for another cooldown', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValue(computeDenial())
	await t.gate({ now: start })
	await t.flush()

	const afterCooldown = start + packageAppUsageBreakerCooldownMs
	const refused = await t
		.gate({ now: afterCooldown })
		.catch((error: unknown) => error)
	expect(isComputeOverageLimitError(refused)).toBe(true)
	const stored = JSON.parse(
		t.store.get('package-app-usage-breaker:v1:org-1:person-1') ?? 'null',
	) as { retryAt: number }
	expect(stored.retryAt).toBe(afterCooldown + packageAppUsageBreakerCooldownMs)
})

test('half-open: only one probe at a time; concurrent requests are refused', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValueOnce(computeDenial())
	await t.gate({ now: start })
	await t.flush()

	let releaseProbe = () => {}
	t.check.mockImplementationOnce(
		() => new Promise<void>((resolve) => (releaseProbe = resolve)),
	)
	const afterCooldown = start + packageAppUsageBreakerCooldownMs
	const probe = t.gate({ now: afterCooldown })
	await vi.waitFor(() => expect(t.check).toHaveBeenCalledTimes(2))
	const concurrent = await t
		.gate({ now: afterCooldown })
		.catch((error: unknown) => error)
	expect(isComputeOverageLimitError(concurrent)).toBe(true)
	releaseProbe()
	await expect(probe).resolves.toBeUndefined()
})

test('the breaker is scoped per visitor: one member over budget does not refuse another', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValueOnce(budgetDenial())
	await t.gate({ now: start })
	await t.flush()

	await expect(
		t.gate({ now: start + 1_000, actorId: 'person-2' }),
	).resolves.toBeUndefined()
	await expect(
		t.gate({ now: start + 1_000, actorId: null }),
	).resolves.toBeUndefined()
	await expect(t.gate({ now: start + 1_000 })).rejects.toSatisfy(
		isBudgetLimitError,
	)
})

test('a denial below the configured threshold does not trip', async () => {
	const t = setup({ limitPercent: '150' })
	t.check.mockRejectedValue(computeDenial(412))
	await t.gate({ now: start })
	await t.flush()
	expect(t.store.size).toBe(0)

	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValue(computeDenial(600))
	await t.gate({ now: start + asyncCheckIntervalMs })
	await t.flush()
	expect(t.store.size).toBe(1)
})

test('an unreadable deny entry fails closed: the check runs before serving', async () => {
	const t = setup()
	vi.spyOn(console, 'warn').mockImplementation(() => {})
	t.failKvReads()

	t.check.mockRejectedValueOnce(computeDenial())
	await expect(t.gate({ now: start })).rejects.toSatisfy(
		isComputeOverageLimitError,
	)

	const checkError = new Error('D1 unavailable')
	t.check.mockRejectedValueOnce(checkError)
	await expect(t.gate({ now: start })).rejects.toBe(checkError)

	await expect(t.gate({ now: start })).resolves.toBeUndefined()
	expect(t.check).toHaveBeenCalledTimes(3)
})

test('a check error after the response is logged and does not open the breaker', async () => {
	const t = setup()
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	t.check.mockRejectedValueOnce(new Error('D1 unavailable'))
	await t.gate({ now: start })
	await t.flush()
	expect(t.store.size).toBe(0)
	expect(warn).toHaveBeenCalledWith(
		'package-app-usage-check-failed',
		expect.any(Error),
	)
})
