import { expect, test } from 'vitest'
import {
	getPackageAppAssetsDirectory,
	parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'
import {
	inferPackageAppAssetContentType,
	listPackageAppAssetFiles,
	resolvePackageAppAssetSourcePath,
	validatePackageAppAssetsDirectory,
} from './package-app-assets-directory.ts'

const sourceFiles = {
	'package.json': '{}',
	'src/app.ts': 'export default {}',
	'public/index.css': 'body {}',
	'public/img/logo.png': 'png',
	'public-extra/other.txt': 'not inside public',
}

test('getPackageAppAssetsDirectory normalizes ./ prefixes and trailing slashes', () => {
	const parse = (assets: string) =>
		getPackageAppAssetsDirectory(
			parseAuthoredPackageJson({
				content: JSON.stringify({
					name: '@kentcdodds/demo',
					exports: {},
					kody: {
						id: 'demo',
						description: 'Demo',
						app: { entry: './src/app.ts', assets },
					},
				}),
			}),
		)
	expect(parse('./public/')).toBe('public')
	expect(parse('public/static')).toBe('public/static')
	expect(parse('./')).toBeNull()
})

test('validatePackageAppAssetsDirectory accepts populated subdirectories and rejects roots, node_modules, and empty directories', () => {
	expect(
		validatePackageAppAssetsDirectory({ assetsDirectory: null, sourceFiles }),
	).toEqual({ ok: true, message: 'No kody.app.assets directory declared.' })
	expect(
		validatePackageAppAssetsDirectory({
			assetsDirectory: 'public',
			sourceFiles,
		}),
	).toEqual({
		ok: true,
		message: 'kody.app.assets serves 2 file(s) from "public".',
	})
	for (const assetsDirectory of [
		'.',
		'node_modules',
		'node_modules/x',
		'../x',
	]) {
		const result = validatePackageAppAssetsDirectory({
			assetsDirectory,
			sourceFiles,
		})
		expect({ assetsDirectory, ok: result.ok }).toEqual({
			assetsDirectory,
			ok: false,
		})
		expect(result.message).toContain('must name a subdirectory')
	}
	const missing = validatePackageAppAssetsDirectory({
		assetsDirectory: 'static',
		sourceFiles,
	})
	expect(missing.ok).toBe(false)
	expect(missing.message).toContain('no files exist under that directory')
})

test('listPackageAppAssetFiles only returns files inside the directory', () => {
	expect(
		listPackageAppAssetFiles({ assetsDirectory: 'public', sourceFiles }),
	).toEqual(['public/img/logo.png', 'public/index.css'])
})

test('resolvePackageAppAssetSourcePath blocks traversal and malformed segments', () => {
	const resolve = (relativePath: string) =>
		resolvePackageAppAssetSourcePath({
			assetsDirectory: 'public',
			relativePath,
		})
	expect(resolve('img/logo.png')).toBe('public/img/logo.png')
	expect(resolve('')).toBeNull()
	expect(resolve('../package.json')).toBeNull()
	expect(resolve('img/../../src/app.ts')).toBeNull()
	expect(resolve('./index.css')).toBeNull()
	expect(resolve('img//logo.png')).toBeNull()
	expect(resolve('img\\logo.png')).toBeNull()
	expect(resolve('a\0b')).toBeNull()
})

test('inferPackageAppAssetContentType maps common web asset extensions and falls back to octet-stream', () => {
	expect(inferPackageAppAssetContentType('public/app.css')).toBe(
		'text/css; charset=utf-8',
	)
	expect(inferPackageAppAssetContentType('vendor/engine.wasm')).toBe(
		'application/wasm',
	)
	expect(inferPackageAppAssetContentType('img/LOGO.PNG')).toBe('image/png')
	expect(inferPackageAppAssetContentType('fonts/inter.woff2')).toBe(
		'font/woff2',
	)
	expect(inferPackageAppAssetContentType('data.unknownext')).toBe(
		'application/octet-stream',
	)
	expect(inferPackageAppAssetContentType('LICENSE')).toBe(
		'application/octet-stream',
	)
})
