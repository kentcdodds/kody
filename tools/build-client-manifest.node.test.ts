import { expect, test } from 'vitest'
import {
	buildClientPreloadManifest,
	lazyAreaNames,
	type ClientMetafile,
} from './build-client-manifest.ts'

test('lazy area names match the client router contract', () => {
	// Must stay in sync with the areas registered in
	// packages/worker/client/lazy-route.tsx (lazy-route.node.test.ts pins the
	// same literal).
	expect([...lazyAreaNames].sort()).toEqual([
		'account-area',
		'admin-area',
		'blog-area',
		'community-area',
		'onboarding-area',
	])
})

const output = (imports: Array<{ path: string; kind: string }>) => ({
	imports,
})
const chunk = (name: string) => `packages/worker/public/assets/${name}`
const staticImport = (name: string) => ({
	path: chunk(name),
	kind: 'import-statement',
})
const dynamicImport = (name: string) => ({
	path: chunk(name),
	kind: 'dynamic-import',
})

test('manifest contains the entry static closure and per-area unique chunks', () => {
	const metafile: ClientMetafile = {
		outputs: {
			'packages/worker/public/client-entry.js': output([
				staticImport('chunk-A.js'),
				dynamicImport('account-area-H1.js'),
				dynamicImport('sentry-init-H2.js'),
			]),
			[chunk('chunk-A.js')]: output([staticImport('chunk-B.js')]),
			[chunk('chunk-B.js')]: output([]),
			[chunk('account-area-H1.js')]: output([
				staticImport('chunk-A.js'),
				staticImport('chunk-C.js'),
			]),
			[chunk('chunk-C.js')]: output([]),
			[chunk('sentry-init-H2.js')]: output([]),
			[chunk('admin-area-H3.js')]: output([]),
			[chunk('blog-area-H4.js')]: output([]),
			[chunk('community-area-H5.js')]: output([]),
			[chunk('onboarding-area-H6.js')]: output([]),
		},
	}

	const manifest = buildClientPreloadManifest(metafile)

	expect([...manifest.entry].sort()).toEqual([
		'/assets/chunk-A.js',
		'/assets/chunk-B.js',
	])
	// Area chunks list themselves first, then deps not already in the entry.
	expect(manifest.areas['account-area']).toEqual([
		'/assets/account-area-H1.js',
		'/assets/chunk-C.js',
	])
	// The lazily loaded Sentry chunk is not preloaded.
	expect(JSON.stringify(manifest)).not.toContain('sentry-init')
})

test('manifest builder rejects a metafile without the client entry', () => {
	expect(() => buildClientPreloadManifest({ outputs: {} })).toThrow(
		/client-entry\.js not found/,
	)
})

test('manifest builder rejects a metafile missing a lazy area chunk', () => {
	const metafile: ClientMetafile = {
		outputs: {
			'packages/worker/public/client-entry.js': output([]),
		},
	}
	expect(() => buildClientPreloadManifest(metafile)).toThrow(
		/Lazy area chunk for "account-area" not found/,
	)
})
