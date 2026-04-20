import { beforeEach, expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	buildPackageSearchProjection: vi.fn(),
	buildSavedPackageEmbedText: vi.fn(),
	deleteJobRow: vi.fn(),
	deleteSavedPackage: vi.fn(),
	deleteSavedPackageVector: vi.fn(),
	getSavedPackageById: vi.fn(),
	insertSavedPackage: vi.fn(),
	listJobRowsByUserId: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	syncJobManagerAlarm: vi.fn(),
	syncPackageJobsForPackage: vi.fn(),
	updateSavedPackage: vi.fn(),
	upsertSavedPackageVector: vi.fn(),
}))

vi.mock('./manifest.ts', () => ({
	buildPackageSearchProjection: (...args: Array<unknown>) =>
		mockModule.buildPackageSearchProjection(...args),
}))

vi.mock('./embed.ts', () => ({
	buildSavedPackageEmbedText: (...args: Array<unknown>) =>
		mockModule.buildSavedPackageEmbedText(...args),
}))

vi.mock('./repo.ts', () => ({
	deleteSavedPackage: (...args: Array<unknown>) =>
		mockModule.deleteSavedPackage(...args),
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	insertSavedPackage: (...args: Array<unknown>) =>
		mockModule.insertSavedPackage(...args),
	updateSavedPackage: (...args: Array<unknown>) =>
		mockModule.updateSavedPackage(...args),
}))

vi.mock('./source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('./vectorize.ts', () => ({
	deleteSavedPackageVector: (...args: Array<unknown>) =>
		mockModule.deleteSavedPackageVector(...args),
	upsertSavedPackageVector: (...args: Array<unknown>) =>
		mockModule.upsertSavedPackageVector(...args),
}))

vi.mock('#worker/jobs/repo.ts', () => ({
	deleteJobRow: (...args: Array<unknown>) => mockModule.deleteJobRow(...args),
	listJobRowsByUserId: (...args: Array<unknown>) =>
		mockModule.listJobRowsByUserId(...args),
}))

vi.mock('#worker/jobs/manager-client.ts', () => ({
	syncJobManagerAlarm: (...args: Array<unknown>) =>
		mockModule.syncJobManagerAlarm(...args),
}))

vi.mock('#worker/jobs/service.ts', () => ({
	syncPackageJobsForPackage: (...args: Array<unknown>) =>
		mockModule.syncPackageJobsForPackage(...args),
}))

const { deleteSavedPackageProjection, refreshSavedPackageProjection } =
	await import('./service.ts')

function createEnv() {
	return {
		APP_DB: {},
	} as Env
}

function createProjection() {
	return {
		name: '@kentcdodds/shade-automation',
		kodyId: 'shade-automation',
		description: 'Shade automation package',
		tags: ['home', 'shades'],
		searchText: 'shade automation',
		hasApp: false,
	}
}

beforeEach(() => {
	for (const value of Object.values(mockModule)) {
		value.mockReset()
	}
	mockModule.buildPackageSearchProjection.mockReturnValue(createProjection())
	mockModule.buildSavedPackageEmbedText.mockReturnValue('saved package embed')
	mockModule.upsertSavedPackageVector.mockResolvedValue(undefined)
	mockModule.syncPackageJobsForPackage.mockResolvedValue(undefined)
	mockModule.syncJobManagerAlarm.mockResolvedValue(undefined)
	mockModule.updateSavedPackage.mockResolvedValue(undefined)
	mockModule.insertSavedPackage.mockResolvedValue(undefined)
	mockModule.deleteSavedPackage.mockResolvedValue(undefined)
	mockModule.deleteSavedPackageVector.mockResolvedValue(undefined)
	mockModule.deleteJobRow.mockResolvedValue(undefined)
})

test('refreshSavedPackageProjection resyncs the job manager after syncing package jobs', async () => {
	const env = createEnv()
	const manifest = {
		name: '@kentcdodds/shade-automation',
		kody: {
			id: 'shade-automation',
			description: 'Shade automation package',
			tags: ['home', 'shades'],
			searchText: 'shade automation',
			jobs: {
				'event-runner': {
					entry: './src/jobs/event-runner.ts',
					schedule: { type: 'interval', every: '1m' },
					timezone: 'America/Denver',
					enabled: true,
				},
			},
		},
	}
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		manifest,
		files: { 'package.json': '{}' },
	})
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/shade-automation',
		kodyId: 'shade-automation',
		description: 'Old description',
		tags: ['home'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		createdAt: '2026-04-20T00:00:00.000Z',
		updatedAt: '2026-04-20T00:00:00.000Z',
	})

	await refreshSavedPackageProjection({
		env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		packageId: 'package-1',
		sourceId: 'source-1',
	})

	expect(mockModule.syncPackageJobsForPackage).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		packageId: 'package-1',
		sourceId: 'source-1',
		manifest,
	})
	expect(mockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
	})
	expect(
		mockModule.syncJobManagerAlarm.mock.invocationCallOrder[0],
	).toBeGreaterThan(
		mockModule.syncPackageJobsForPackage.mock.invocationCallOrder[0],
	)
})

test('deleteSavedPackageProjection resyncs the job manager after removing package jobs', async () => {
	const env = createEnv()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		sourceId: 'source-1',
	})
	mockModule.listJobRowsByUserId.mockResolvedValue([
		{ id: 'job-1', source_id: 'source-1' },
		{ id: 'job-2', source_id: 'source-other' },
	])

	await deleteSavedPackageProjection({
		env,
		userId: 'user-1',
		packageId: 'package-1',
	})

	expect(mockModule.deleteJobRow).toHaveBeenCalledTimes(1)
	expect(mockModule.deleteJobRow).toHaveBeenCalledWith({}, 'user-1', 'job-1')
	expect(mockModule.deleteSavedPackage).toHaveBeenCalledWith(
		{},
		{
			userId: 'user-1',
			packageId: 'package-1',
		},
	)
	expect(mockModule.deleteSavedPackageVector).toHaveBeenCalledWith(
		env,
		'package-1',
	)
	expect(mockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
	})
	expect(
		mockModule.syncJobManagerAlarm.mock.invocationCallOrder[0],
	).toBeGreaterThan(mockModule.deleteSavedPackage.mock.invocationCallOrder[0])
})
