import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { buildPackageJobId } from '#worker/jobs/package-job-id.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	listEnablementsForInstance: vi.fn(),
}))

vi.mock('./repo.ts', () => ({
	listEnablementsForInstance: (...args: Array<unknown>) =>
		mockModule.listEnablementsForInstance(...args),
}))

const { resolveCronJobEnablementHint } =
	await import('./job-enablement-hint.ts')

const env = {} as Env
const orgId = ownerIdFromStored('user-1')
const jobId = buildPackageJobId('pkg-1', 'inbox-refresh')

test('resolveCronJobEnablementHint is null when the job is off or already on', async () => {
	expect(
		await resolveCronJobEnablementHint({
			env,
			orgId,
			jobId,
			jobName: 'inbox-refresh',
			enabled: false,
		}),
	).toBeNull()
	expect(mockModule.listEnablementsForInstance).not.toHaveBeenCalled()

	mockModule.listEnablementsForInstance.mockResolvedValueOnce([{ state: 'on' }])
	expect(
		await resolveCronJobEnablementHint({
			env,
			orgId,
			jobId,
			jobName: 'inbox-refresh',
			enabled: true,
		}),
	).toBeNull()
})

test('resolveCronJobEnablementHint asks the user with the exact enablementEnable call', async () => {
	mockModule.listEnablementsForInstance.mockResolvedValueOnce([])
	expect(
		await resolveCronJobEnablementHint({
			env,
			orgId,
			jobId,
			jobName: 'inbox-refresh',
			enabled: true,
		}),
	).toBe(
		'Ask the user whether to enable cron "inbox-refresh" for them: enablementEnable({ packageId: "pkg-1", triggerKind: "cron", triggerName: "inbox-refresh" }). Publishing and jobs.enabled never turn a trigger on.',
	)

	mockModule.listEnablementsForInstance.mockResolvedValueOnce([
		{ state: 'paused' },
	])
	expect(
		await resolveCronJobEnablementHint({
			env,
			orgId,
			jobId,
			jobName: 'inbox-refresh',
			enabled: true,
		}),
	).toBe(
		'Ask the user to fix the paused enablement for cron "inbox-refresh", or re-enable with enablementEnable({ packageId: "pkg-1", triggerKind: "cron", triggerName: "inbox-refresh" }).',
	)
})

test('resolveCronJobEnablementHint returns null when the lookup fails', async () => {
	consoleWarn.mockImplementation(() => {})
	mockModule.listEnablementsForInstance.mockRejectedValueOnce(
		new Error('D1 unavailable'),
	)
	expect(
		await resolveCronJobEnablementHint({
			env,
			orgId,
			jobId,
			jobName: 'inbox-refresh',
			enabled: true,
		}),
	).toBeNull()
	expect(consoleWarn).toHaveBeenCalledWith(
		'cron-job-enablement-hint-failed',
		expect.any(Error),
	)
})
