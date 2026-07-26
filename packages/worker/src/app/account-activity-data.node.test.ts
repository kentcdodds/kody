import { expect, test, vi } from 'vitest'
import {
	loadAccountActivityData,
	readAccountActivityFilters,
	readAccountActivitySelectedRunId,
	statusFilterToRunStatus,
	surfaceFilterToRunSurface,
} from '#app/account-activity-data.ts'
import { type RunRecord } from '#worker/run-records/types.ts'

const mockModule = vi.hoisted(() => ({
	listRunRecords: vi.fn(),
	getRunRecord: vi.fn(),
	summarizeRunRecords: vi.fn(),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: (...args: Array<unknown>) =>
		mockModule.listRunRecords(...args),
	getRunRecord: (...args: Array<unknown>) => mockModule.getRunRecord(...args),
	summarizeRunRecords: (...args: Array<unknown>) =>
		mockModule.summarizeRunRecords(...args),
}))

const user = {
	sessionUserId: '42',
	userId: 42,
	username: 'test-user',
	email: 'user@example.com',
	displayName: 'user',
	artifactOwnerIds: [],
	mcpUser: {
		userId: 'stable-user-1',
		email: 'user@example.com',
		username: 'test-user',
		displayName: 'user',
	},
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		id: 'run-1',
		surface: 'job',
		status: 'error',
		name: 'Morning digest',
		packageId: null,
		kodyId: null,
		sourceId: 'source-1',
		publishedCommit: null,
		storageId: 'storage-1',
		jobId: 'job-1',
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: '2026-07-25T09:00:00.000Z',
		finishedAt: '2026-07-25T09:00:01.000Z',
		durationMs: 1000,
		errorName: 'Error',
		errorMessage: 'boom',
		metadata: {},
		logCount: 2,
		...overrides,
	}
}

test('activity helpers parse filters and prefer path selected run ids', () => {
	expect(
		readAccountActivityFilters('https://example.com/account/activity'),
	).toEqual({
		statusFilter: 'error',
		surfaceFilter: 'all',
		cursor: null,
	})
	expect(
		readAccountActivityFilters(
			'https://example.com/account/activity?status=all&surface=job&cursor=abc',
		),
	).toEqual({
		statusFilter: 'all',
		surfaceFilter: 'job',
		cursor: 'abc',
	})
	expect(statusFilterToRunStatus('error')).toBe('error')
	expect(statusFilterToRunStatus('all')).toBeNull()
	expect(surfaceFilterToRunSurface('all')).toBeNull()
	expect(surfaceFilterToRunSurface('webhook')).toBe('webhook')

	expect(
		readAccountActivitySelectedRunId(
			'https://example.com/account/activity/run-path?selected=run-query',
			'run-path-param',
		),
	).toBe('run-path-param')
	expect(
		readAccountActivitySelectedRunId(
			'https://example.com/account/activity/run-path',
		),
	).toBe('run-path')
	expect(
		readAccountActivitySelectedRunId(
			'https://example.com/account/activity?selected=run-query',
		),
	).toBe('run-query')
})

test('loadAccountActivityData maps filters, summary, pagination, detail, and cursors', async () => {
	const run = makeRun()
	mockModule.summarizeRunRecords.mockResolvedValue({
		since: '2026-07-19T12:00:00.000Z',
		total: 4,
		errors: 1,
		running: 0,
		bySurface: [{ surface: 'job', total: 4, errors: 1 }],
	})
	mockModule.listRunRecords.mockResolvedValue({
		runs: [run],
		nextCursor: 'cursor-2',
	})
	mockModule.getRunRecord.mockResolvedValue({
		run,
		logs: [
			{
				runId: run.id,
				sequence: 1,
				level: 'error',
				message: 'second',
				fields: null,
			},
			{
				runId: run.id,
				sequence: 0,
				level: 'log',
				message: 'first',
				fields: null,
			},
		],
	})

	const env = {} as Env
	const data = await loadAccountActivityData({
		env,
		request: new Request(
			'https://example.com/account/activity/run-1?status=error&surface=job',
		),
		user,
		now: new Date('2026-07-26T12:00:00.000Z'),
	})

	expect(mockModule.summarizeRunRecords).toHaveBeenCalledWith({
		env,
		userId: 'stable-user-1',
		since: '2026-07-19T12:00:00.000Z',
	})
	expect(mockModule.listRunRecords).toHaveBeenCalledWith({
		env,
		userId: 'stable-user-1',
		filter: {
			status: 'error',
			surface: 'job',
			since: '2026-07-19T12:00:00.000Z',
		},
		limit: 25,
		cursor: null,
	})
	expect(mockModule.getRunRecord).toHaveBeenCalledWith({
		env,
		userId: 'stable-user-1',
		runId: 'run-1',
	})
	expect(data).toMatchObject({
		ok: true,
		statusFilter: 'error',
		surfaceFilter: 'job',
		summary: {
			total: 4,
			errors: 1,
			running: 0,
		},
		nextCursor: 'cursor-2',
		selectedRunId: 'run-1',
		retentionDays: 30,
		runs: [
			expect.objectContaining({
				id: 'run-1',
				surface: 'job',
				status: 'error',
				errorMessage: 'boom',
			}),
		],
		selectedRun: expect.objectContaining({
			id: 'run-1',
			logs: [
				expect.objectContaining({ sequence: 0, message: 'first' }),
				expect.objectContaining({ sequence: 1, message: 'second' }),
			],
		}),
	})

	mockModule.listRunRecords.mockResolvedValue({
		runs: [],
		nextCursor: null,
	})
	mockModule.getRunRecord.mockResolvedValue(null)

	await loadAccountActivityData({
		env: {} as Env,
		request: new Request(
			'https://example.com/account/activity.json?status=all&cursor=page-2',
		),
		user,
		now: new Date('2026-07-26T12:00:00.000Z'),
	})

	expect(mockModule.listRunRecords).toHaveBeenCalledWith(
		expect.objectContaining({
			filter: {
				status: null,
				surface: null,
				since: '2026-07-19T12:00:00.000Z',
			},
			cursor: 'page-2',
		}),
	)
})
