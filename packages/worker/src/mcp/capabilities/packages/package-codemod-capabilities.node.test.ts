import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	runPackageCodemodStep: vi.fn(),
	getPackageCodemodRunById: vi.fn(),
	listPackageCodemods: vi.fn(),
}))

vi.mock('#worker/package-codemods/engine.ts', () => ({
	runPackageCodemodStep: (...args: Array<unknown>) =>
		mockModule.runPackageCodemodStep(...args),
}))

vi.mock('#worker/package-codemods/ledger.ts', () => ({
	getPackageCodemodRunById: (...args: Array<unknown>) =>
		mockModule.getPackageCodemodRunById(...args),
}))

vi.mock('#worker/package-codemods/registry.ts', () => ({
	listPackageCodemods: (...args: Array<unknown>) =>
		mockModule.listPackageCodemods(...args),
}))

const { packageCodemodApplyCapability } =
	await import('./package-codemod-apply.ts')
const { packageCodemodListCapability } =
	await import('./package-codemod-list.ts')
const { packageCodemodRevertCapability } =
	await import('./package-codemod-revert.ts')
const { packagesDomain } = await import('./domain.ts')

function createCtx(userId = 'user-1') {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId,
				email: 'user@example.com',
				displayName: 'User',
			},
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

function emptyStepResult(input: {
	runId: string
	codemodId: string
	mode: 'scan' | 'dry-run' | 'apply' | 'revert'
}) {
	return {
		runId: input.runId,
		codemodId: input.codemodId,
		mode: input.mode,
		items: [],
		nextCursor: null,
		summary: {},
	}
}

test('package codemod capabilities stay self-scoped and reject anonymous callers', async () => {
	const names = packagesDomain.capabilities.map((capability) => capability.name)
	expect(names).toEqual(
		expect.arrayContaining([
			'package_codemod_list',
			'package_codemod_apply',
			'package_codemod_revert',
		]),
	)
	expect(JSON.stringify(packageCodemodApplyCapability.inputSchema)).not.toMatch(
		/"userId"/,
	)

	mockModule.listPackageCodemods.mockReturnValue([
		{
			id: '0001-ambient-storage-to-package-storage',
			description: 'Migrate ambient storage imports.',
		},
	])
	await expect(
		packageCodemodListCapability.handler({}, createCtx()),
	).resolves.toEqual({
		codemods: [
			{
				id: '0001-ambient-storage-to-package-storage',
				description: 'Migrate ambient storage imports.',
			},
		],
	})

	mockModule.runPackageCodemodStep.mockResolvedValue(
		emptyStepResult({
			runId: 'run-1',
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'apply',
		}),
	)
	await expect(
		packageCodemodApplyCapability.handler(
			{
				codemodId: '0001-ambient-storage-to-package-storage',
				packageIds: ['pkg-1'],
				limit: 10,
			},
			createCtx('user-1'),
		),
	).resolves.toMatchObject({
		runId: 'run-1',
		mode: 'apply',
	})
	expect(mockModule.runPackageCodemodStep).toHaveBeenCalledWith({
		env: { APP_DB: {} },
		baseUrl: 'https://heykody.dev',
		initiatedByUserId: 'user-1',
		codemodId: '0001-ambient-storage-to-package-storage',
		mode: 'apply',
		scope: { kind: 'user', userId: 'user-1' },
		filters: { packageIds: ['pkg-1'] },
		runId: undefined,
		cursor: undefined,
		limit: 10,
	})

	mockModule.getPackageCodemodRunById.mockResolvedValueOnce({
		id: 'apply-run-other',
		codemodId: '0001-ambient-storage-to-package-storage',
		mode: 'apply',
		scopeUserId: 'user-2',
		initiatedByUserId: 'user-2',
		filtersJson: '{}',
		status: 'completed',
		revertOfRunId: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	})
	await expect(
		packageCodemodRevertCapability.handler(
			{ revertOfRunId: 'apply-run-other' },
			createCtx('user-1'),
		),
	).rejects.toThrow(/not scoped to the signed-in user/i)

	mockModule.getPackageCodemodRunById.mockResolvedValueOnce({
		id: 'apply-run-self',
		codemodId: '0001-ambient-storage-to-package-storage',
		mode: 'apply',
		scopeUserId: 'user-1',
		initiatedByUserId: 'user-1',
		filtersJson: '{}',
		status: 'completed',
		revertOfRunId: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	})
	mockModule.runPackageCodemodStep.mockResolvedValueOnce(
		emptyStepResult({
			runId: 'revert-run-1',
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'revert',
		}),
	)
	await expect(
		packageCodemodRevertCapability.handler(
			{ revertOfRunId: 'apply-run-self', cursor: 'item-1' },
			createCtx('user-1'),
		),
	).resolves.toMatchObject({ runId: 'revert-run-1', mode: 'revert' })
	expect(mockModule.runPackageCodemodStep).toHaveBeenLastCalledWith({
		env: { APP_DB: {} },
		baseUrl: 'https://heykody.dev',
		initiatedByUserId: 'user-1',
		codemodId: '0001-ambient-storage-to-package-storage',
		mode: 'revert',
		scope: { kind: 'user', userId: 'user-1' },
		runId: undefined,
		cursor: 'item-1',
		limit: undefined,
		revertOfRunId: 'apply-run-self',
	})

	mockModule.getPackageCodemodRunById.mockResolvedValueOnce({
		id: 'apply-run-fleet',
		codemodId: '0001-ambient-storage-to-package-storage',
		mode: 'apply',
		scopeUserId: null,
		initiatedByUserId: 'admin-1',
		filtersJson: '{}',
		status: 'completed',
		revertOfRunId: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	})
	mockModule.runPackageCodemodStep.mockResolvedValueOnce(
		emptyStepResult({
			runId: 'revert-run-fleet',
			codemodId: '0001-ambient-storage-to-package-storage',
			mode: 'revert',
		}),
	)
	await expect(
		packageCodemodRevertCapability.handler(
			{ revertOfRunId: 'apply-run-fleet' },
			createCtx('user-1'),
		),
	).resolves.toMatchObject({ runId: 'revert-run-fleet', mode: 'revert' })
	expect(mockModule.runPackageCodemodStep).toHaveBeenLastCalledWith(
		expect.objectContaining({
			scope: { kind: 'user', userId: 'user-1' },
			revertOfRunId: 'apply-run-fleet',
		}),
	)

	mockModule.runPackageCodemodStep.mockClear()
	const anonymousCtx = {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: null,
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
	await expect(
		packageCodemodApplyCapability.handler(
			{ codemodId: '0001-ambient-storage-to-package-storage' },
			anonymousCtx,
		),
	).rejects.toThrow(/authenticated/i)
	await expect(
		packageCodemodRevertCapability.handler(
			{ revertOfRunId: 'apply-run-1' },
			anonymousCtx,
		),
	).rejects.toThrow(/authenticated/i)
	expect(mockModule.runPackageCodemodStep).not.toHaveBeenCalled()
})
