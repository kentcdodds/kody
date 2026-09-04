import { expect, test } from 'vitest'
import { findOriginViteDeferredAssets } from './origin-vite-startup-build.ts'

test('classifies hashed Vite origin deferred assets', () => {
	expect(
		findOriginViteDeferredAssets([
			'guide-catalog-BKLgV76U.js',
			'worker-bundler-DkncWciV.js',
			'worker-bundler-typescript-CF82MPh-.js',
			'oauth-provider-DuOVB_DS.js',
			'esbuild-eina1h7z.wasm',
			'index.js',
			'account-area-Bk2HBZxv.js',
		]),
	).toEqual({
		guideCatalog: ['guide-catalog-BKLgV76U.js'],
		workerBundler: [
			'worker-bundler-DkncWciV.js',
			'worker-bundler-typescript-CF82MPh-.js',
		],
		oauthProvider: ['oauth-provider-DuOVB_DS.js'],
		esbuildWasm: ['esbuild-eina1h7z.wasm'],
	})
})
