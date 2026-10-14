import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	user: { mcpUser: { userId: 'person-1' } } as unknown,
	scope: { baseUrl: 'https://kody.test' } as unknown,
	loadScope: vi.fn(),
	resolve: vi.fn(),
	approve: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: async () => mocks.user,
}))

vi.mock('#app/package-credentials-access.ts', () => ({
	loadPackageMappingScopeForViewer: mocks.loadScope,
}))

vi.mock('#worker/credentials/credential-approval.ts', () => ({
	resolveCredentialApproval: mocks.resolve,
	approveCredentialProposal: mocks.approve,
}))

const { createPackageCredentialApprovalApiHandler } =
	await import('./package-credential-approval.ts')

const url = new URL(
	'https://kody.test/profiles/acme/packages/digest/approve-credentials.json?mine[mail]=resend-prod&reason=Digest',
)
const call = (init?: RequestInit) =>
	createPackageCredentialApprovalApiHandler({} as Env).handler({
		request: new Request(url, init),
		url,
		params: { username: 'acme', kodyId: 'digest' },
	} as never)
const post = (body: unknown) =>
	call({
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
const view = { ok: true, canApprove: true, fingerprint: 'f1' }

test('GET resolves the query proposal for the signed-in viewer', async () => {
	mocks.loadScope.mockResolvedValue(mocks.scope)
	mocks.resolve.mockResolvedValue({ view, resolved: [] })
	expect((await call({ method: 'PUT' })).status).toBe(405)
	const response = await call()
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual(view)
	expect(mocks.resolve).toHaveBeenCalledWith(mocks.scope, {
		changes: [
			{
				target: { type: 'default', layer: 'mine' },
				needKey: 'mail',
				credentials: [{ name: 'resend-prod' }],
			},
		],
		enable: [],
		sender: null,
		reason: 'Digest',
		errors: [],
	})

	mocks.loadScope.mockResolvedValueOnce(null)
	expect((await call()).status).toBe(404)
	const signedIn = mocks.user
	mocks.user = null
	expect((await call()).status).toBe(401)
	mocks.user = signedIn
})

test('POST approve maps each outcome to a status', async () => {
	mocks.loadScope.mockResolvedValue(mocks.scope)
	expect((await post({ action: 'approve' })).status).toBe(400)
	expect((await post({ action: 'other', fingerprint: 'f1' })).status).toBe(400)
	expect(mocks.approve).not.toHaveBeenCalled()

	mocks.approve.mockResolvedValueOnce({ status: 'approved', view })
	const approved = await post({ action: 'approve', fingerprint: 'f1' })
	expect(approved.status).toBe(200)
	await expect(approved.json()).resolves.toEqual({ ok: true, view })
	expect(mocks.approve).toHaveBeenCalledWith(
		expect.objectContaining({ scope: mocks.scope, fingerprint: 'f1' }),
	)

	mocks.approve.mockResolvedValueOnce({ status: 'invalid', view })
	const invalid = await post({ action: 'approve', fingerprint: 'f1' })
	expect(invalid.status).toBe(400)
	await expect(invalid.json()).resolves.toMatchObject({ ok: false, view })

	mocks.approve.mockResolvedValueOnce({ status: 'stale', view })
	const stale = await post({ action: 'approve', fingerprint: 'f0' })
	expect(stale.status).toBe(409)
	await expect(stale.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('changed since you reviewed'),
		view,
	})

	mocks.approve.mockResolvedValueOnce({
		status: 'conflict',
		message: 'Webhook "incoming" is already on for another person.',
		view,
	})
	const conflict = await post({ action: 'approve', fingerprint: 'f1' })
	expect(conflict.status).toBe(409)
	await expect(conflict.json()).resolves.toEqual({
		ok: false,
		error: 'Webhook "incoming" is already on for another person.',
		view,
	})
})
