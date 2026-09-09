import { expect, test } from 'vitest'
import {
	createStableDynamicWorkerId,
	dynamicWorkerCacheKeyVersion,
} from '#mcp/dynamic-worker-id.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'

function createWorkerOptions(modules: Record<string, string>) {
	return {
		...createDynamicWorkerCompatibilityOptions(),
		mainModule: 'executor.js',
		modules,
	}
}

async function mintId(input: {
	userId?: string | null
	storageContext?: StorageContext | null
	modules?: Record<string, string>
	cacheKeyVersion?: number
}) {
	return await createStableDynamicWorkerId({
		userId: input.userId === undefined ? 'user-1' : input.userId,
		storageContext:
			input.storageContext === undefined ? null : input.storageContext,
		workerOptions: {
			...createDynamicWorkerCompatibilityOptions(),
			mainModule: 'executor.js',
			modules: input.modules ?? {
				'executor.js': 'export default class Executor {}',
			},
		},
		cacheKeyVersion: input.cacheKeyVersion,
	})
}

test('createStableDynamicWorkerId is stable for the same modules, user, and storage context', async () => {
	const modules = {
		'executor.js': 'export default class Executor { evaluate() { return 1 } }',
	}
	const storageContext = {
		sessionId: 'session-1',
		appId: 'app-1',
		storageId: 'storage-1',
	}

	const first = await mintId({ modules, storageContext })
	const second = await mintId({ modules, storageContext })
	expect(first).toBe(second)
	expect(first).toMatch(/^kody-[A-Za-z0-9_-]{43}$/)

	expect(await mintId({ modules, storageContext, userId: 'user-1' })).toBe(
		first,
	)

	const otherUser = await mintId({
		modules,
		storageContext,
		userId: 'user-2',
	})
	expect(otherUser).not.toBe(first)

	const otherStorage = await mintId({
		modules,
		userId: 'user-1',
		storageContext: {
			sessionId: 'session-2',
			appId: 'app-1',
			storageId: 'storage-1',
		},
	})
	expect(otherStorage).not.toBe(first)

	const otherCode = await mintId({
		modules: {
			'executor.js':
				'export default class Executor { evaluate() { return 2 } }',
		},
		storageContext,
	})
	expect(otherCode).not.toBe(first)

	const bumped = await mintId({
		modules,
		storageContext,
		cacheKeyVersion: dynamicWorkerCacheKeyVersion + 1,
	})
	expect(bumped).not.toBe(first)
	expect(await mintId({ modules, storageContext })).toBe(first)

	const missingUser = await mintId({
		modules,
		userId: null,
		storageContext: null,
	})
	const missingUserAgain = await mintId({
		modules,
		userId: null,
		storageContext: null,
	})
	expect(missingUser).toBe(missingUserAgain)
	expect(missingUser).not.toBe(first)

	const nonHashableFirst = await createStableDynamicWorkerId({
		userId: 'user-1',
		storageContext: null,
		workerOptions: createWorkerOptions({
			'executor.js': 'export default class Executor {}',
		}),
	})
	const nonHashable = await createStableDynamicWorkerId({
		userId: 'user-1',
		storageContext: null,
		workerOptions: {
			...createDynamicWorkerCompatibilityOptions(),
			mainModule: 'executor.js',
			modules: {
				'executor.js': {
					js: 'export default class Executor {}',
					onLoad: async () => 'not-hashable',
				} as never,
			},
		},
	})
	const nonHashableAgain = await createStableDynamicWorkerId({
		userId: 'user-1',
		storageContext: null,
		workerOptions: {
			...createDynamicWorkerCompatibilityOptions(),
			mainModule: 'executor.js',
			modules: {
				'executor.js': {
					js: 'export default class Executor {}',
					onLoad: async () => 'not-hashable',
				} as never,
			},
		},
	})
	expect(nonHashable).not.toBe(nonHashableAgain)
	expect(nonHashable).not.toBe(nonHashableFirst)
})
