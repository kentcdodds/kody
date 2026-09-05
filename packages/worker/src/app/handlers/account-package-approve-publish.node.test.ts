import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	loadAccountPackageApprovePublishData: vi.fn(),
	loadPackagePage: vi.fn(),
	renderAppPage: vi.fn(async () => new Response('ok')),
	requireAuthenticatedPageUser: vi.fn(),
}))

vi.mock('#app/account-package-publish-lock.ts', () => ({
	loadAccountPackageApprovePublishData: (...args: Array<unknown>) =>
		mockModule.loadAccountPackageApprovePublishData(...args),
}))
vi.mock('#app/package-page.ts', () => ({
	loadPackagePage: (...args: Array<unknown>) =>
		mockModule.loadPackagePage(...args),
}))
vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mockModule.requireAuthenticatedPageUser(...args),
}))
vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (...args: Array<unknown>) => mockModule.renderAppPage(...args),
}))
vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: vi.fn(),
}))

const { createAccountPackageApprovePublishHandler } =
	await import('./account-package-approve-publish.ts')

const user = {
	username: 'kentcdodds',
	email: 'kent@example.com',
	mcpUser: { userId: 'user-1' },
}

test('legacy package approval links redirect and the canonical owner URL renders', async () => {
	mockModule.requireAuthenticatedPageUser.mockResolvedValue(user)
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'pkg-1',
		kodyId: 'github-triage',
	})
	const handler = createAccountPackageApprovePublishHandler({
		APP_DB: {},
	} as Env)

	const legacy = await handler.handler({
		request: new Request(
			'https://example.com/account/packages/pkg-1/approve-publish?commit=abc1234',
		),
		params: { packageId: 'pkg-1' },
	} as never)
	expect(legacy.status).toBe(302)
	expect(legacy.headers.get('location')).toBe(
		'https://example.com/@kentcdodds/github-triage/approve-publish?commit=abc1234',
	)

	const ownerPackage = {
		id: 'pkg-1',
		kodyId: 'github-triage',
		name: '@kentcdodds/github-triage',
	}
	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'page',
		viewerIsOwner: true,
		ownerPackage,
	})
	mockModule.loadAccountPackageApprovePublishData.mockResolvedValue({
		ok: true,
		package: ownerPackage,
	})

	const canonical = await handler.handler({
		request: new Request(
			'https://example.com/@kentcdodds/github-triage/approve-publish?commit=abc1234',
		),
		params: { username: 'kentcdodds', kodyId: 'github-triage' },
	} as never)
	expect(canonical.status).toBe(200)
	expect(mockModule.loadAccountPackageApprovePublishData).toHaveBeenCalledWith({
		env: expect.any(Object),
		request: expect.any(Request),
		user,
		packageId: 'pkg-1',
	})
	expect(mockModule.renderAppPage).toHaveBeenCalledWith(
		expect.objectContaining({
			title: 'Approve package publish',
			loaderData: expect.objectContaining({
				accountPackageApprovePublish: expect.objectContaining({ ok: true }),
			}),
		}),
	)
})
