import { beforeEach, expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	captureException: vi.fn(),
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getEntitySourceById: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	publishFromExternalRef: vi.fn(),
}))

vi.mock('@sentry/cloudflare', () => ({
	captureException: (...args: Array<unknown>) =>
		mockModule.captureException(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: () => ({
		publishFromExternalRef: (...args: Array<unknown>) =>
			mockModule.publishFromExternalRef(...args),
	}),
}))

const { publishExternalPushCapability } =
	await import('./publish-external-push.ts')

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- this legacy suite resets shared hoisted mocks between tests.
beforeEach(() => {
	for (const value of Object.values(mockModule)) {
		value.mockReset()
	}
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		kodyId: 'demo-package',
		name: '@kentcdodds/demo-package',
		sourceId: 'source-1',
	})
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-package-1',
		published_commit: 'commit-old',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		created_at: '2026-05-04T00:00:00.000Z',
		updated_at: '2026-05-04T00:00:00.000Z',
	})
})

function createContext() {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://kody.test',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
			},
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

test('publishes a new external Artifacts HEAD', async () => {
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-new',
		manifest: {},
		checks: [{ kind: 'manifest', ok: true, message: 'ok' }],
	})

	const result = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(result.status).toBe('published')
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			userId: 'user-1',
			newCommit: 'commit-new',
			expectedHead: 'commit-new',
			allowForce: false,
		}),
	)
})

test('returns already_published when Artifacts HEAD matches D1', async () => {
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-old',
	})

	const result = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(result).toEqual({
		status: 'already_published',
		published_commit: 'commit-old',
	})
	expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()
})

test('surfaces not-fast-forward refusal without force', async () => {
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-rewrite',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'not_fast_forward',
		previous_commit: 'commit-old',
		published_commit: 'commit-rewrite',
		message: 'The external Artifacts HEAD is not a descendant.',
	})

	const result = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(result.status).toBe('not_fast_forward')
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({
			allowForce: false,
		}),
	)
})

test('passes allow_force through to the publish pipeline', async () => {
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-rewrite',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-rewrite',
		manifest: {},
		checks: [],
	})

	await publishExternalPushCapability.handler(
		{ package_id: 'package-1', allow_force: true },
		createContext(),
	)

	expect(mockModule.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({
			allowForce: true,
		}),
	)
})

test('retries transient Durable Object resets with a fresh external publish session', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.publishFromExternalRef
		.mockRejectedValueOnce(
			new Error('Durable Object exceeded its CPU time limit and was reset'),
		)
		.mockResolvedValueOnce({
			status: 'published',
			previous_commit: 'commit-old',
			published_commit: 'commit-new',
			manifest: {},
			checks: [{ kind: 'manifest', ok: true, message: 'ok' }],
		})

	try {
		const result = await publishExternalPushCapability.handler(
			{ package_id: 'package-1' },
			createContext(),
		)

		expect(result.status).toBe('published')
		expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(2)
		expect(mockModule.publishFromExternalRef).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				sessionId: 'external-publish-source-1',
			}),
		)
		expect(mockModule.publishFromExternalRef).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				sessionId: 'external-publish-source-1-retry-2',
			}),
		)
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				'package_publish_external_push transient Durable Object reset',
			),
		)
		expect(mockModule.captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({
				tags: {
					scope: 'package_publish_external_push.transient-do-reset',
				},
			}),
		)
	} finally {
		warnSpy.mockRestore()
	}
})

test('returns already_published when a retry observes that the reset attempt committed', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.getEntitySourceById
		.mockResolvedValueOnce({
			id: 'source-1',
			user_id: 'user-1',
			entity_kind: 'package',
			entity_id: 'package-1',
			repo_id: 'package-package-1',
			published_commit: 'commit-old',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			last_external_check_at: null,
			created_at: '2026-05-04T00:00:00.000Z',
			updated_at: '2026-05-04T00:00:00.000Z',
		})
		.mockResolvedValueOnce({
			id: 'source-1',
			user_id: 'user-1',
			entity_kind: 'package',
			entity_id: 'package-1',
			repo_id: 'package-package-1',
			published_commit: 'commit-new',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			last_external_check_at: null,
			created_at: '2026-05-04T00:00:00.000Z',
			updated_at: '2026-05-04T00:00:00.000Z',
		})
	mockModule.publishFromExternalRef.mockRejectedValueOnce(
		new Error(
			"Durable Object's isolate exceeded its memory limit and was reset",
		),
	)

	try {
		const result = await publishExternalPushCapability.handler(
			{ package_id: 'package-1' },
			createContext(),
		)

		expect(result).toEqual({
			status: 'already_published',
			published_commit: 'commit-new',
		})
		expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(1)
	} finally {
		warnSpy.mockRestore()
	}
})

test('replaces exhausted transient reset attempts with a stable error message', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.publishFromExternalRef.mockRejectedValue(
		new Error('Durable Object exceeded its CPU time limit and was reset'),
	)

	try {
		await expect(
			publishExternalPushCapability.handler(
				{ package_id: 'package-1' },
				createContext(),
			),
		).rejects.toThrow(
			'package_publish_external_push could not recover after 3 transient Durable Object reset attempts',
		)
		expect(mockModule.publishFromExternalRef).toHaveBeenCalledTimes(3)
		expect(mockModule.captureException).toHaveBeenCalledTimes(3)
	} finally {
		warnSpy.mockRestore()
	}
})

test('check failure leaves mutation to the shared publish pipeline', async () => {
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'checks_failed',
		failed_checks: [{ kind: 'typecheck', ok: false, message: 'bad types' }],
		manifest: {},
		run_id: 'run-1',
	})

	const result = await publishExternalPushCapability.handler(
		{ package_id: 'package-1' },
		createContext(),
	)

	expect(result).toEqual({
		status: 'checks_failed',
		failed_checks: [{ kind: 'typecheck', ok: false, message: 'bad types' }],
		manifest: {},
		run_id: 'run-1',
	})
})
