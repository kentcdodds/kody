import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'

const mocks = vi.hoisted(() => ({
	user: { mcpUser: { userId: 'person-1' } } as unknown,
	scope: { baseUrl: 'https://kody.test' } as unknown,
	resolved: [] as Array<Record<string, unknown>>,
	write: vi.fn(async () => {}),
	loadScope: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: async () => mocks.user,
}))

vi.mock('#app/package-credentials-access.ts', () => ({
	loadPackageMappingScopeForViewer: mocks.loadScope,
}))

vi.mock('#worker/credentials/package-credential-mappings.ts', () => ({
	buildPackageCredentialsView: async () => ({ ok: true, view: 'fresh' }),
	loadPackageMappingScope: async () => mocks.scope,
}))

vi.mock(
	'#worker/credentials/package-credential-mapping-changes.ts',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		resolveMappingChanges: async () => mocks.resolved,
		writeMappingChanges: mocks.write,
	}),
)

const { createPackageCredentialsApiHandler } =
	await import('./package-credentials.ts')
const { MappingWriteRefused } =
	await import('#worker/credentials/package-credential-mapping-changes.ts')

const url = 'https://kody.test/profiles/acme/packages/digest/credentials.json'
const call = (init?: RequestInit) =>
	createPackageCredentialsApiHandler({} as Env).handler({
		request: new Request(url, init),
		params: { username: 'acme', kodyId: 'digest' },
	} as never)
const post = (body: unknown) =>
	call({
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
const change = {
	target: { type: 'default', layer: 'mine' },
	needKey: 'mail',
	credentials: [{ name: 'resend-prod' }],
}

test('reads need a session and package:execute, and only GET and POST are allowed', async () => {
	mocks.loadScope.mockResolvedValue(mocks.scope)
	expect((await call({ method: 'DELETE' })).status).toBe(405)
	const view = await call()
	expect(view.status).toBe(200)
	await expect(view.json()).resolves.toEqual({ ok: true, view: 'fresh' })
	expect(mocks.loadScope).toHaveBeenCalledWith(
		expect.objectContaining({ username: 'acme', kodyId: 'digest' }),
	)

	mocks.loadScope.mockResolvedValueOnce(null)
	expect((await call()).status).toBe(404)

	const signedIn = mocks.user
	mocks.user = null
	expect((await call()).status).toBe(401)
	mocks.user = signedIn
})

test('writes apply every change or none and return the fresh view', async () => {
	mocks.loadScope.mockResolvedValue(mocks.scope)
	const bad = await post({ changes: [{ ...change, needKey: '' }] })
	expect(bad.status).toBe(400)
	await expect(bad.json()).resolves.toMatchObject({ ok: false })
	expect((await post({ changes: [] })).status).toBe(400)

	mocks.resolved = [
		{ ...change, error: null },
		{
			...change,
			needKey: 'nope',
			error: { code: 'need_unknown', message: 'No need "nope".' },
		},
	]
	const refused = await post({
		changes: [change, { ...change, needKey: 'nope' }],
	})
	expect(refused.status).toBe(400)
	await expect(refused.json()).resolves.toEqual({
		ok: false,
		errors: [
			{
				needKey: 'nope',
				target: change.target,
				code: 'need_unknown',
				message: 'No need "nope".',
			},
		],
	})
	expect(mocks.write).not.toHaveBeenCalled()

	mocks.resolved = [{ ...change, error: null }]
	const saved = await post({ changes: [change] })
	expect(saved.status).toBe(200)
	await expect(saved.json()).resolves.toEqual({ ok: true, view: 'fresh' })
	expect(mocks.write).toHaveBeenCalledTimes(1)

	mocks.write.mockRejectedValueOnce(
		new McpCallerError('Webhook "incoming" is already on for another person.'),
	)
	expect((await post({ changes: [change] })).status).toBe(409)

	const resolvedChange = { ...change, error: null } as never
	mocks.write.mockRejectedValueOnce(
		new MappingWriteRefused(
			resolvedChange,
			'webhook_other_enabler',
			'Webhook "incoming" is already on for another person.',
		),
	)
	expect((await post({ changes: [change] })).status).toBe(409)

	mocks.write.mockRejectedValueOnce(
		new MappingWriteRefused(
			resolvedChange,
			'trigger_unknown',
			'No cron "daily".',
		),
	)
	const gone = await post({ changes: [change] })
	expect(gone.status).toBe(400)
	await expect(gone.json()).resolves.toEqual({
		ok: false,
		errors: [
			{
				needKey: 'mail',
				target: change.target,
				code: 'trigger_unknown',
				message: 'No cron "daily".',
			},
		],
	})
})
