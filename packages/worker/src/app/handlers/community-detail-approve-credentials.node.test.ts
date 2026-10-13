import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	user: { mcpUser: { userId: 'person-1' } } as unknown,
	page: { kind: 'page', viewerIsOwner: false, ownerPackage: null } as unknown,
	loadScope: vi.fn(),
	render: vi.fn(),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: async () => mocks.user,
}))

vi.mock('#app/package-page.ts', () => ({
	loadPackagePage: async () => mocks.page,
	ownerPackageForClient: vi.fn(),
	packagePageIsPrivate: vi.fn(),
}))

vi.mock('#app/package-credentials-access.ts', () => ({
	loadPackageMappingScopeForViewer: mocks.loadScope,
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: mocks.render,
}))

const { createCommunityPackageCredentialApprovalHandler } =
	await import('./community-detail.tsx')

const url = new URL(
	'https://kody.test/profiles/acme/packages/digest/approve-credentials?mine[mail]=resend-prod',
)
const call = () =>
	createCommunityPackageCredentialApprovalHandler({} as Env).handler({
		request: new Request(url),
		url,
		params: { username: 'acme', kodyId: 'digest' },
	} as never)

test('the approval page opens for anyone with package:execute, not only owners', async () => {
	mocks.render.mockImplementation(
		async (input: { status?: number }) =>
			new Response(null, { status: input.status ?? 200 }),
	)
	mocks.loadScope.mockResolvedValueOnce({ baseUrl: 'https://kody.test' })
	expect((await call()).status).toBe(200)
	expect(mocks.loadScope).toHaveBeenCalledWith(
		expect.objectContaining({
			user: mocks.user,
			username: 'acme',
			kodyId: 'digest',
		}),
	)

	mocks.loadScope.mockResolvedValueOnce(null)
	expect((await call()).status).toBe(404)
})
