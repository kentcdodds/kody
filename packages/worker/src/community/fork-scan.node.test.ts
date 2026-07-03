import { expect, test } from 'vitest'
import {
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

test('rewritePackageManifestForFork preserves fields and rewrites scope and kody id', () => {
	const { content, targetName } = rewritePackageManifestForFork({
		manifestContent: sampleManifest,
		expectedPackageScope: 'jane',
		targetKodyId: 'my-discord-gateway',
	})

	expect(targetName).toBe('@jane/my-discord-gateway')

	const parsed = JSON.parse(content) as {
		name: string
		license: string
		exports: Record<string, string>
		kody: {
			id: string
			description: string
			tags: Array<string>
			dependencies: Array<string>
		}
	}

	expect(parsed.name).toBe('@jane/my-discord-gateway')
	expect(parsed.license).toBe('MIT')
	expect(parsed.exports).toEqual({ '.': './src/index.ts' })
	expect(parsed.kody.id).toBe('my-discord-gateway')
	expect(parsed.kody.description).toBe('Discord helpers')
	expect(parsed.kody.tags).toEqual(['discord'])
	expect(parsed.kody.dependencies).toEqual([
		'@owner/shared-utils',
		'@forker/local-lib',
	])
	expect(content).toContain('\t')
})

test('rewritePackageManifestForFork supports kody id override independent of listing id', () => {
	const { content } = rewritePackageManifestForFork({
		manifestContent: sampleManifest,
		expectedPackageScope: '@jane',
		targetKodyId: 'custom-id',
	})
	const parsed = JSON.parse(content) as { name: string; kody: { id: string } }
	expect(parsed.name).toBe('@jane/custom-id')
	expect(parsed.kody.id).toBe('custom-id')
})

test('scanCrossScopeReferences detects kody.dependencies from other scopes', () => {
	const references = scanCrossScopeReferences({
		files: {
			'package.json': sampleManifest,
		},
		expectedPackageScope: 'jane',
	})

	expect(references).toEqual([
		{ file: 'package.json', specifier: '@forker/local-lib' },
		{ file: 'package.json', specifier: '@owner/shared-utils' },
	])
})

test('scanCrossScopeReferences detects kody: imports in source files', () => {
	const references = scanCrossScopeReferences({
		files: {
			'package.json': `{
	"name": "@owner/pkg",
	"kody": { "id": "pkg", "description": "Pkg" },
	"exports": { ".": "./src/index.ts" }
}
`,
			'src/index.ts': `import { helper } from 'kody:@owner/shared-utils/helper'
import { local } from 'kody:@jane/local-lib/local'
const sameScope = 'kody:@jane/pkg'
`,
			'src/util.ts': `export const value = "kody:@other-scope/dep/file.ts"`,
		},
		expectedPackageScope: 'jane',
	})

	expect(references).toEqual([
		{ file: 'src/index.ts', specifier: 'kody:@owner/' },
		{ file: 'src/util.ts', specifier: 'kody:@other-scope/' },
	])
})

test('scanCrossScopeReferences ignores same-scope references', () => {
	const references = scanCrossScopeReferences({
		files: {
			'package.json': `{
	"name": "@jane/pkg",
	"kody": {
		"id": "pkg",
		"description": "Pkg",
		"dependencies": ["@jane/local-lib"]
	},
	"exports": { ".": "./src/index.ts" }
}
`,
			'src/index.ts': `import { x } from 'kody:@jane/local-lib/x'`,
		},
		expectedPackageScope: 'jane',
	})

	expect(references).toEqual([])
})

test('scanCrossScopeReferences deduplicates repeated specifiers per file', () => {
	const references = scanCrossScopeReferences({
		files: {
			'src/index.ts': `import 'kody:@owner/a/x'
import 'kody:@owner/a/y'`,
		},
		expectedPackageScope: 'jane',
	})

	expect(references).toEqual([
		{ file: 'src/index.ts', specifier: 'kody:@owner/' },
	])
})
