import { expect, test } from 'vitest'
import { consoleInfo } from '#worker/test-support/console-spies.ts'
import { timePublishExternalPushPhase } from './publish-phase-timing.ts'

test('timePublishExternalPushPhase logs duration for success and failure', async () => {
	const { value, durationMs } = await timePublishExternalPushPhase(
		{
			phase: 'rebuild',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
		},
		async () => 'done',
	)
	expect(value).toBe('done')
	expect(durationMs).toBeGreaterThanOrEqual(0)
	expect(consoleInfo).toHaveBeenCalledWith(
		expect.stringContaining('"message":"packagePublishExternalPush phase"'),
	)
	expect(consoleInfo).toHaveBeenCalledWith(
		expect.stringContaining('"phase":"rebuild"'),
	)

	consoleInfo.mockClear()
	await expect(
		timePublishExternalPushPhase({ phase: 'clone', sourceId: 'source-1' }, () =>
			Promise.reject(new Error('clone failed')),
		),
	).rejects.toThrow('clone failed')
	expect(consoleInfo).toHaveBeenCalledWith(
		expect.stringContaining('"phase":"clone"'),
	)
})
