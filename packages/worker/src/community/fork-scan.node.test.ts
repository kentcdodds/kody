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

test('rewritePackageManifestForFork rewrites scope and kody id while preserving other fields', () => {
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
	expect(parsed.private).toBe(true)
	expect(parsed.exports).toEqual({ '.': './src/index.ts' })
	expect(parsed.kody.id).toBe('my-discord-gateway')
	expect(parsed.kody.tags).toEqual(['discord'])
	expect(parsed.kody.dependencies).toEqual([
		'@owner/shared-utils',
		'@forker/local-lib',
	])

	const override = rewritePackageManifestForFork({
		manifestContent: sampleManifest,
		expectedPackageScope: '@jane',
		targetKodyId: 'custom-id',
	})
	const overrideParsed = JSON.parse(override.content) as {
		name: string
		kody: { id: string }
	}
	expect(overrideParsed.name).toBe('@jane/custom-id')
	expect(overrideParsed.kody.id).toBe('custom-id')
})

test('scanCrossScopeReferences finds foreign scopes and ignores same-scope references', () => {
	const crossScope = scanCrossScopeReferences({
		files: {
			'package.json': sampleManifest,
			'src/index.ts': `import { helper } from 'kody:@owner/shared-utils/helper'
import { local } from 'kody:@jane/local-lib/local'
const sameScope = 'kody:@jane/pkg'
`,
			'src/util.ts': `export const value = "kody:@other-scope/dep/file.ts"
import 'kody:@owner/a/x'
import 'kody:@owner/a/y'`,
		},
		expectedPackageScope: 'jane',
	})

	expect(crossScope).toEqual([
		{ file: 'package.json', specifier: '@forker/local-lib' },
		{ file: 'package.json', specifier: '@owner/shared-utils' },
		{ file: 'src/index.ts', specifier: 'kody:@owner/' },
		{ file: 'src/util.ts', specifier: 'kody:@other-scope/' },
		{ file: 'src/util.ts', specifier: 'kody:@owner/' },
	])

	const sameScopeOnly = scanCrossScopeReferences({
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

	expect(sameScopeOnly).toEqual([])
})

test('scanCrossScopeReferences allows platform scopes to remain in forked packages', () => {
	const files = {
		'package.json': `{
	"name": "@jane/pkg",
	"kody": {
		"id": "pkg",
		"description": "Pkg",
		"dependencies": ["@kody/github", "@owner/shared-utils"]
	},
	"exports": { ".": "./src/index.ts" }
}
`,
		'src/index.ts': `import gh from 'kody:@kody/github/issues'
import util from 'kody:@owner/util/helper'`,
	}

	const withAllowlist = scanCrossScopeReferences({
		files,
		expectedPackageScope: 'jane',
		allowedForeignScopes: ['kody'],
	})
	expect(withAllowlist).toEqual([
		{ file: 'package.json', specifier: '@owner/shared-utils' },
		{ file: 'src/index.ts', specifier: 'kody:@owner/' },
	])

	const withoutAllowlist = scanCrossScopeReferences({
		files,
		expectedPackageScope: 'jane',
	})
	expect(
		withoutAllowlist.some((entry) => entry.specifier === 'kody:@kody/'),
	).toBe(true)
})
