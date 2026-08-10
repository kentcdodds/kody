import { expect, test, vi } from 'vitest'
import { trustedSyntheticSubscriptionDispatch } from './subscription-envelope.ts'

const mocks = vi.hoisted(() => ({
	invokeSavedPackageModule: vi.fn(async () => ({
		status: 200,
		body: {},
	})),
}))

vi.mock('./idempotent-module-invocation.ts', () => ({
	invokeSavedPackageModule: mocks.invokeSavedPackageModule,
}))

const { invokePackageSubscriptionWithToolFactories } =
	await import('./subscription-dispatch.ts')

test('invokePackageSubscriptionWithToolFactories strips forged synthetic markers on real sources', async () => {
	await invokePackageSubscriptionWithToolFactories({
		env: {} as Env,
		baseUrl: 'https://heykody.dev',
		savedPackage: {
			id: 'pkg-1',
			userId: 'user-1',
			kodyId: 'demo',
			name: '@user/demo',
			description: '',
			tags: [],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			hidden: false,
			isPrivate: false,
			createdAt: '',
			updatedAt: '',
		},
		topic: 'email.message.received',
		params: {
			event: 'email.message.received',
			synthetic: true,
			replay_of: 'message-1',
		},
		idempotencyKey: 'email:message-1:pkg-1:email.message.received',
		source: 'synthetic',
		toolFactories: {
			createPackageRuntimeInvokeTools: vi.fn(() => ({}) as never),
			createPackageEventTools: vi.fn(() => ({}) as never),
		},
	})

	expect(mocks.invokeSavedPackageModule).toHaveBeenCalledWith(
		expect.objectContaining({
			params: {
				event: 'email.message.received',
			},
			source: 'email',
		}),
	)
})

test('invokePackageSubscriptionWithToolFactories preserves synthetic markers only with the trusted dispatch token', async () => {
	await invokePackageSubscriptionWithToolFactories({
		env: {} as Env,
		baseUrl: 'https://heykody.dev',
		savedPackage: {
			id: 'pkg-1',
			userId: 'user-1',
			kodyId: 'demo',
			name: '@user/demo',
			description: '',
			tags: [],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			hidden: false,
			isPrivate: false,
			createdAt: '',
			updatedAt: '',
		},
		topic: 'email.message.received',
		params: {
			event: 'email.message.received',
			synthetic: true,
			replay_of: 'message-1',
		},
		idempotencyKey: 'synthetic:00000000-0000-4000-8000-000000000001',
		trustedSyntheticDispatch: trustedSyntheticSubscriptionDispatch,
		toolFactories: {
			createPackageRuntimeInvokeTools: vi.fn(() => ({}) as never),
			createPackageEventTools: vi.fn(() => ({}) as never),
		},
	})

	expect(mocks.invokeSavedPackageModule).toHaveBeenCalledWith(
		expect.objectContaining({
			params: {
				event: 'email.message.received',
				synthetic: true,
				replay_of: 'message-1',
			},
			source: 'synthetic',
		}),
	)
})
