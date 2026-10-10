import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	createStableDynamicWorkerId,
	dynamicWorkerCacheKeyVersion,
} from '#mcp/dynamic-worker-id.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'

const modules = {
	'executor.js': 'export default class Executor { evaluate() { return 1 } }',
}
const storageContext = {
	sessionId: 'session-1',
	appId: 'app-1',
	storageId: 'storage-1',
}

async function mintId(
	input: {
		userId?: string | null
		storageContext?: StorageContext | null
		modules?: Record<string, unknown>
		cacheKeyVersion?: number
	} = {},
) {
	return await createStableDynamicWorkerId({
		userId: input.userId === undefined ? 'user-1' : input.userId,
		storageContext:
			input.storageContext === undefined
				? storageContext
				: input.storageContext,
		workerOptions: {
			...createDynamicWorkerCompatibilityOptions(),
			mainModule: 'executor.js',
			modules: (input.modules ?? modules) as Record<string, string>,
		},
		cacheKeyVersion: input.cacheKeyVersion,
	})
}

test('createStableDynamicWorkerId is stable for the same modules, user, and storage context and ignores evaluate-time params', async () => {
	const first = await mintId()
	expect(first).toMatch(/^kody-[A-Za-z0-9_-]{43}$/)
	// Same modules + user + storage mint one id. Evaluate-time params and
	// packageContext are not hash inputs; they must not appear in `modules`.
	expect(await mintId()).toBe(first)
	expect(await mintId({ userId: ownerIdFromStored('user-1') })).toBe(first)

	const variants = {
		otherUser: await mintId({ userId: ownerIdFromStored('user-2') }),
		otherStorage: await mintId({
			storageContext: { ...storageContext, sessionId: 'session-2' },
		}),
		otherCode: await mintId({
			modules: {
				'executor.js':
					'export default class Executor { evaluate() { return 2 } }',
			},
		}),
		bumped: await mintId({ cacheKeyVersion: dynamicWorkerCacheKeyVersion + 1 }),
		missingUser: await mintId({ userId: null, storageContext: null }),
	}
	expect(Object.entries(variants).filter(([, id]) => id === first)).toEqual([])
	expect(await mintId()).toBe(first)
	expect(await mintId({ userId: null, storageContext: null })).toBe(
		variants.missingUser,
	)
})

test('createStableDynamicWorkerId hashes binary and untyped module fields deterministically', async () => {
	const binaryModules = () => ({
		'executor.js': 'export default class Executor {}',
		'lib.wasm': { wasm: new Uint8Array([0, 97, 115, 109]) },
		'data.bin': { data: new Uint8Array([1, 2, 3]).buffer },
		'config.json': { json: { b: [1, 2n], a: 'x' } },
	})
	const first = await mintId({ modules: binaryModules() })
	expect(await mintId({ modules: binaryModules() })).toBe(first)
	expect(
		await mintId({
			modules: {
				...binaryModules(),
				'data.bin': { data: new Uint8Array([1, 2, 4]).buffer },
			},
		}),
	).not.toBe(first)
})

test('createStableDynamicWorkerId rejects function-valued module fields instead of minting a one-off id', async () => {
	await expect(
		mintId({
			modules: {
				'executor.js': {
					js: 'export default class Executor {}',
					onLoad: async () => 'not-hashable',
				},
			},
		}),
	).rejects.toThrow(
		'Dynamic Worker id input $.modules.executor.js.onLoad is a function',
	)
})
