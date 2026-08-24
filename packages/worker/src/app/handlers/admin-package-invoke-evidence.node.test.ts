import { expect, test, vi } from 'vitest'
import { createAdminPackageInvokeEvidenceApiHandler } from './admin-package-invoke-evidence.ts'

const mocks = vi.hoisted(() => ({
	requireUserWithRole: vi.fn(),
	loadAggregate: vi.fn(),
}))

vi.mock('#app/permissions-server.ts', () => ({
	requireUserWithRole: (...args: Array<unknown>) =>
		mocks.requireUserWithRole(...args),
}))

vi.mock('#worker/package-invocations/prefixless-evidence-admin.ts', () => ({
	loadPackageInvokePrefixlessEvidenceAggregate: (...args: Array<unknown>) =>
		mocks.loadAggregate(...args),
}))

test('package-invoke evidence endpoint is admin-only and returns only aggregate data', async () => {
	const env = {} as Env
	const request = new Request(
		'https://example.test/admin/insights/package-invoke-prefixless-evidence.json',
	)
	const handler = createAdminPackageInvokeEvidenceApiHandler(env)
	const aggregate = {
		epoch: 'deployment-v1',
		totals: { execute: 0, package: 0, job: 0, app: 0 },
		population: {
			usersExpected: 2,
			usersEnumerated: 2,
			usersAttempted: 2,
			usersLoaded: 2,
			usersMissingEpoch: 0,
			usersUnreachable: 0,
			pagesScanned: 1,
			complete: true,
		},
	}
	mocks.requireUserWithRole.mockResolvedValue({ mcpUser: { userId: 'admin' } })
	mocks.loadAggregate.mockResolvedValue(aggregate)

	const response = await handler.handler({
		request,
		params: {},
		url: new URL(request.url),
	} as never)
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual(aggregate)
	expect(mocks.requireUserWithRole).toHaveBeenCalledWith(request, env, 'admin')

	mocks.loadAggregate.mockClear()
	mocks.requireUserWithRole.mockRejectedValue(
		new Response('Forbidden', { status: 403 }),
	)
	const forbidden = await handler.handler({
		request,
		params: {},
		url: new URL(request.url),
	} as never)
	expect(forbidden.status).toBe(403)
	expect(mocks.loadAggregate).not.toHaveBeenCalled()
})
