import { expect, test } from 'vitest'
import {
	collectChangedForkFiles,
	rewriteForkedPackageSelfReferences,
	rewritePackageManifestForFork,
	scanCrossScopeReferences,
} from './fork-scan.ts'

const sampleManifest = `{
	"name": "@owner/discord-gateway",
	"license": "MIT",
	"exports": {
		".": "./src/index.ts"
	},
	"kody": {
		"id": "discord-gateway",
		"description": "Discord helpers",
		"tags": ["discord"],
		"dependencies": [
			"@owner/shared-utils",
			"@forker/local-lib"
		]
	}
}
`

function janeManifest(dependencies: unknown) {
	return JSON.stringify({
		name: '@jane/pkg',
		kody: { id: 'pkg', description: 'Pkg', dependencies },
		exports: { '.': './src/index.ts' },
	})
}

function scanAsJane(files: Record<string, string>) {
	return scanCrossScopeReferences({
		files,
		expectedPackageScope: 'jane',
	})
}

test('rewritePackageManifestForFork rewrites scope and kody id while preserving other fields', () => {
	const { content, targetName } = rewritePackageManifestForFork({
		manifestContent: sampleManifest,
		expectedPackageScope: 'jane',
		targetKodyId: 'my-discord-gateway',
	})
	expect(targetName).toBe('@jane/my-discord-gateway')
	expect(JSON.parse(content)).toMatchObject({
		name: '@jane/my-discord-gateway',
		license: 'MIT',
		private: true,
		exports: { '.': './src/index.ts' },
		kody: {
			id: 'my-discord-gateway',
			tags: ['discord'],
			dependencies: ['@owner/shared-utils', '@forker/local-lib'],
		},
	})

	const override = rewritePackageManifestForFork({
		manifestContent: sampleManifest,
		expectedPackageScope: '@jane',
		targetKodyId: 'custom-id',
	})
	expect(JSON.parse(override.content)).toMatchObject({
		name: '@jane/custom-id',
		kody: { id: 'custom-id' },
	})
})

test('scanCrossScopeReferences finds foreign scopes and ignores same-scope references', () => {
	expect(
		scanAsJane({
			'package.json': sampleManifest,
			'src/index.ts': `import { helper } from 'kody:@owner/shared-utils/helper'
import { local } from 'kody:@jane/local-lib/local'
const sameScope = 'kody:@jane/pkg'
`,
			'src/util.ts': `export const value = "kody:@other-scope/dep/file.ts"
import 'kody:@owner/a/x'
import 'kody:@owner/a/y'`,
		}),
	).toEqual([
		{ file: 'package.json', specifier: '@forker/local-lib' },
		{ file: 'package.json', specifier: '@owner/shared-utils' },
		{ file: 'src/index.ts', specifier: 'kody:@owner/' },
		{ file: 'src/util.ts', specifier: 'kody:@other-scope/' },
		{ file: 'src/util.ts', specifier: 'kody:@owner/' },
	])

	expect(
		scanAsJane({
			'package.json': janeManifest(['@jane/local-lib']),
			'src/index.ts': `import { x } from 'kody:@jane/local-lib/x'`,
		}),
	).toEqual([])

	expect(
		scanAsJane({
			'package.json': janeManifest({
				'@owner/shared-utils': '*',
				'@jane/local-lib': '*',
			}),
		}),
	).toEqual([{ file: 'package.json', specifier: '@owner/shared-utils' }])
})

test('scanCrossScopeReferences treats every other org scope as foreign', () => {
	const files = {
		'package.json': janeManifest(['@kody/github', '@owner/shared-utils']),
		'src/index.ts': `import gh from 'kody:@kody/github/issues'
import util from 'kody:@owner/util/helper'`,
	}
	expect(scanAsJane(files)).toEqual([
		{ file: 'package.json', specifier: '@kody/github' },
		{ file: 'package.json', specifier: '@owner/shared-utils' },
		{ file: 'src/index.ts', specifier: 'kody:@kody/' },
		{ file: 'src/index.ts', specifier: 'kody:@owner/' },
	])
})

test('rewriteForkedPackageSelfReferences rewrites only the forked package name', () => {
	const files = rewriteForkedPackageSelfReferences({
		files: {
			'package.json':
				'{"dependencies":{"@kody/github":"*","@kody/shared":"*"}}',
			'index.ts': `import gh from 'kody:@kody/github/issues'
import shared from 'kody:@kody/shared/util'
`,
		},
		originPackageName: '@kody/github',
		nextPackageName: '@alice/github',
	})
	expect(files['index.ts']).toContain('kody:@alice/github/issues')
	expect(files['index.ts']).toContain('kody:@kody/shared/util')
	expect(files['package.json']).toContain('"@alice/github"')
	expect(files['package.json']).toContain('"@kody/shared"')

	const templateLiteral = rewriteForkedPackageSelfReferences({
		files: {
			'job.ts': 'await packages.invoke(`kody:@kody/github/issues`)\n',
		},
		originPackageName: '@kody/github',
		nextPackageName: '@alice/github',
	})
	expect(templateLiteral['job.ts']).toContain('kody:@alice/github/issues')
})

test('collectChangedForkFiles returns only rewritten paths', () => {
	expect(
		collectChangedForkFiles({
			originFiles: {
				'package.json': '{"name":"@owner/demo"}',
				'src/index.ts': 'export const n = "@owner/demo"\n',
				'poster.png': 'binary-bytes',
			},
			rewrittenFiles: {
				'package.json': '{"name":"@jane/demo"}',
				'src/index.ts': 'export const n = "@jane/demo"\n',
				'poster.png': 'binary-bytes',
			},
		}),
	).toEqual({
		'package.json': '{"name":"@jane/demo"}',
		'src/index.ts': 'export const n = "@jane/demo"\n',
	})
})
