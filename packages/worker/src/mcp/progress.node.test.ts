import { expect, test, vi } from 'vitest'
import {
	createProgressReporter,
	executeProgressPhaseMessages,
	reportCapabilityProgress,
	reportExecutePhaseProgress,
} from './progress.ts'

test('progress reporters speak both SDK shapes, swallow notify failures, and map execute phases', async () => {
	expect(createProgressReporter(undefined)).toBeNull()
	expect(createProgressReporter({})).toBeNull()
	expect(
		createProgressReporter({
			_meta: { progressToken: 'tok-1' },
		}),
	).toBeNull()

	const sendNotification = vi.fn().mockResolvedValue(undefined)
	const v1 = createProgressReporter({
		_meta: { progressToken: 'tok-v1' },
		sendNotification,
	})
	expect(v1).not.toBeNull()
	await v1!({ progress: 2, total: 5, message: 'halfway' })
	expect(sendNotification).toHaveBeenCalledWith({
		method: 'notifications/progress',
		params: {
			progressToken: 'tok-v1',
			progress: 2,
			total: 5,
			message: 'halfway',
		},
	})

	const notify = vi.fn().mockResolvedValue(undefined)
	const v2 = createProgressReporter({
		mcpReq: {
			_meta: { progressToken: 42 },
			notify,
		},
	})
	expect(v2).not.toBeNull()
	await v2!({ progress: 1, message: 'starting' })
	expect(notify).toHaveBeenCalledWith({
		method: 'notifications/progress',
		params: {
			progressToken: 42,
			progress: 1,
			message: 'starting',
		},
	})

	const failingNotify = vi.fn().mockRejectedValue(new Error('stream closed'))
	const resilient = createProgressReporter({
		mcpReq: {
			_meta: { progressToken: 'tok' },
			notify: failingNotify,
		},
	})
	await expect(resilient!({ progress: 1 })).resolves.toBeUndefined()

	const reportProgress = vi.fn().mockResolvedValue(undefined)
	await reportExecutePhaseProgress(reportProgress, 'hydrate')
	expect(reportProgress).toHaveBeenCalledWith({
		progress: 2,
		total: 4,
		message: executeProgressPhaseMessages.hydrate,
	})

	await expect(
		reportCapabilityProgress(null, { progress: 1, message: 'nope' }),
	).resolves.toBeUndefined()
})
