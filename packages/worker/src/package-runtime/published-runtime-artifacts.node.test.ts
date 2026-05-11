import { expect, test } from 'vitest'
import {
	buildPublishedBundleArtifactKvKey,
	readPublishedBundleArtifact,
	writePublishedBundleArtifact,
	type PublishedBundleArtifact,
} from './published-runtime-artifacts.ts'
import { getKodyRuntimeShimRevision } from './runtime-module.ts'

function createMemoryKv(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial))
	return {
		values,
		kv: {
			async get(key: string, type?: 'json') {
				const value = values.get(key) ?? null
				if (type === 'json') {
					return value == null ? null : JSON.parse(value)
				}
				return value
			},
			async put(key: string, value: string) {
				values.set(key, value)
			},
			async delete(key: string) {
				values.delete(key)
			},
		} as unknown as KVNamespace,
	}
}

function createArtifact(
	overrides: Partial<PublishedBundleArtifact> = {},
): PublishedBundleArtifact {
	return {
		version: 1,
		runtimeShimRevision: getKodyRuntimeShimRevision(),
		kind: 'module',
		artifactName: '.',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		entryPoint: 'src/index.ts',
		mainModule: 'dist/index.js',
		modules: {
			'dist/index.js':
				'import { codemode } from "../.__kody_virtual__/runtime.js"; export default async function run() { return codemode.secret_list({}) }',
			'.__kody_virtual__/runtime.js': 'export const codemode = undefined;',
		},
		dependencies: [],
		packageContext: null,
		serviceContext: null,
		createdAt: '2026-05-11T00:00:00.000Z',
		...overrides,
	}
}

test('published bundle artifact keys include the host runtime shim revision', () => {
	const key = buildPublishedBundleArtifactKvKey({
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		kind: 'module',
		artifactName: '.',
		entryPoint: 'src/index.ts',
	})

	expect(key).toBe(
		`bundle-artifact:v1:${getKodyRuntimeShimRevision()}:source-1:commit-1:module:.:src/index.ts`,
	)
})

test('readPublishedBundleArtifact treats stale runtime shim artifacts as cache misses', async () => {
	const staleArtifact = createArtifact({
		runtimeShimRevision: 'abi1-stale-runtime',
	})
	const { kv } = createMemoryKv({
		'kv:stale': JSON.stringify(staleArtifact),
	})

	const artifact = await readPublishedBundleArtifact({
		env: { BUNDLE_ARTIFACTS_KV: kv } as Env,
		kvKey: 'kv:stale',
	})

	expect(artifact).toBeNull()
})

test('writePublishedBundleArtifact stamps the current runtime shim revision', async () => {
	const { kv, values } = createMemoryKv()

	await writePublishedBundleArtifact({
		env: { BUNDLE_ARTIFACTS_KV: kv } as Env,
		kvKey: 'kv:current',
		artifact: createArtifact({
			runtimeShimRevision: 'abi1-old-runtime',
		}),
	})
	const stored = JSON.parse(values.get('kv:current') ?? '{}') as {
		runtimeShimRevision?: string
	}

	expect(stored.runtimeShimRevision).toBe(getKodyRuntimeShimRevision())
	await expect(
		readPublishedBundleArtifact({
			env: { BUNDLE_ARTIFACTS_KV: kv } as Env,
			kvKey: 'kv:current',
		}),
	).resolves.toMatchObject({
		runtimeShimRevision: getKodyRuntimeShimRevision(),
		mainModule: 'dist/index.js',
	})
})
