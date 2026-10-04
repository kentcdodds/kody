import { expect, test } from 'vitest'
import {
	assertNoPlatformSuppliedNodeModules,
	listNodeModulesPackageRoots,
} from './package-bundle-node-modules.ts'

test('assertNoPlatformSuppliedNodeModules allows snapshot node_modules and refuses injected remix or left-pad', () => {
	const snapshotFiles = {
		'src/index.ts': 'export const ok = true',
		'node_modules/preact/package.json': '{"name":"preact"}',
		'node_modules/preact/dist/preact.js': 'export {}',
	}
	const preparedFiles = {
		...snapshotFiles,
		'.__kody_virtual__/bootstrap.js': 'export {}',
	}
	assertNoPlatformSuppliedNodeModules({
		snapshotFiles,
		bundlerFiles: preparedFiles,
		bundleLabel: 'Package bundle',
	})
	expect(listNodeModulesPackageRoots(preparedFiles)).toEqual(['preact'])

	const remixSnapshotFiles = {
		...snapshotFiles,
		'node_modules/remix/package.json': '{"name":"remix"}',
		'node_modules/remix/dist/router.js':
			'export function createRouter() { return {} }',
	}
	const remixBundlerFiles = {
		...preparedFiles,
		'node_modules/remix/package.json':
			remixSnapshotFiles['node_modules/remix/package.json'],
		'node_modules/remix/dist/router.js':
			remixSnapshotFiles['node_modules/remix/dist/router.js'],
	}
	assertNoPlatformSuppliedNodeModules({
		snapshotFiles: remixSnapshotFiles,
		bundlerFiles: remixBundlerFiles,
		bundleLabel: 'Package bundle',
	})
	expect(
		Object.keys(remixBundlerFiles)
			.filter((filePath) => filePath.startsWith('node_modules/remix/'))
			.sort((left, right) => left.localeCompare(right)),
	).toEqual([
		'node_modules/remix/dist/router.js',
		'node_modules/remix/package.json',
	])
	expect(listNodeModulesPackageRoots(remixBundlerFiles)).toEqual([
		'preact',
		'remix',
	])

	expect(() =>
		assertNoPlatformSuppliedNodeModules({
			snapshotFiles,
			bundlerFiles: {
				...preparedFiles,
				'node_modules/remix/package.json': '{"name":"remix"}',
				'node_modules/remix/dist/component.js': 'export {}',
			},
			bundleLabel: 'Package bundle',
		}),
	).toThrow(
		/Package bundle includes node_modules paths the package snapshot does not contain \("node_modules\/remix\/dist\/component.js", "node_modules\/remix\/package.json"\)/,
	)

	expect(() =>
		assertNoPlatformSuppliedNodeModules({
			snapshotFiles: { 'src/client.ts': 'console.log("hi")' },
			bundlerFiles: {
				'src/client.ts': 'console.log("hi")',
				'node_modules/left-pad/index.js': 'module.exports = () => {}',
			},
			bundleLabel: 'Package client bundle',
		}),
	).toThrow(
		/Package client bundle includes node_modules paths the package snapshot does not contain \("node_modules\/left-pad\/index.js"\)/,
	)
})

test('listNodeModulesPackageRoots reports scoped and unscoped packages', () => {
	expect(
		listNodeModulesPackageRoots({
			'src/index.ts': 'export {}',
			'node_modules/left-pad/index.js': 'module.exports = () => {}',
			'node_modules/@remix-run/ui/package.json': '{"name":"@remix-run/ui"}',
			'node_modules/@remix-run/ui/dist/tabs.js': 'export {}',
			'node_modules/remix/package.json': '{"name":"remix"}',
		}),
	).toEqual(['@remix-run/ui', 'left-pad', 'remix'])
})
