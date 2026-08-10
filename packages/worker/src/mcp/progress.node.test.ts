import { expect, test, vi } from 'vitest'
import {
	createProgressReporter,
	executeProgressPhaseMessages,
	reportCapabilityProgress,
	reportExecutePhaseProgress,
} from './progress.ts'

test('createProgressReporter returns null without a progress token or sender', () => {
	expect(createProgressReporter(undefined)).toBeNull()
	expect(createProgressReporter({})).toBeNull()
	expect(
		createProgressReporter({
			_meta: { progressToken: 'tok-1' },
		}),
	).toBeNull()
	expect(
		createProgressReporter({
			sendNotification: vi.fn(),
		}),
	).toBeNull()
})

test('createProgressReporter uses SDK v1 sendNotification', async () => {
	const sendNotification = vi.fn().mockResolvedValue(undefined)
	const report = createProgressReporter({
		_meta: { progressToken: 'tok-v1' },
		sendNotification,
	})
	expect(report).not.toBeNull()
	await report!({ progress: 2, total: 5, message: 'halfway' })
	expect(sendNotification).toHaveBeenCalledWith({
		method: 'notifications/progress',
		params: {
			progressToken: 'tok-v1',
			progress: 2,
			total: 5,
			message: 'halfway',
		},
	})
})

test('createProgressReporter uses SDK v2 mcpReq.notify', async () => {
	const notify = vi.fn().mockResolvedValue(undefined)
	const report = createProgressReporter({
		mcpReq: {
			_meta: { progressToken: 42 },
			notify,
		},
	})
	expect(report).not.toBeNull()
	await report!({ progress: 1, message: 'starting' })
	expect(notify).toHaveBeenCalledWith({
		method: 'notifications/progress',
		params: {
			progressToken: 42,
			progress: 1,
			message: 'starting',
		},
	})
})

test('createProgressReporter swallows notify failures', async () => {
	const notify = vi.fn().mockRejectedValue(new Error('stream closed'))
	const report = createProgressReporter({
		mcpReq: {
			_meta: { progressToken: 'tok' },
			notify,
		},
	})
	await expect(report!({ progress: 1 })).resolves.toBeUndefined()
})

test('reportExecutePhaseProgress maps serverTiming phase names', async () => {
	const reportProgress = vi.fn().mockResolvedValue(undefined)
	await reportExecutePhaseProgress(reportProgress, 'hydrate')
	expect(reportProgress).toHaveBeenCalledWith({
		progress: 2,
		total: 4,
		message: executeProgressPhaseMessages.hydrate,
	})
})

test('reportCapabilityProgress no-ops when reporter is missing', async () => {
	await expect(
		reportCapabilityProgress(null, { progress: 1, message: 'nope' }),
	).resolves.toBeUndefined()
})
