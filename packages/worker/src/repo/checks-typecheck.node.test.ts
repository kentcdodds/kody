import { expect, test } from 'vitest'
import {
	runRepoChecks,
	typecheckPackageEntrypointsFromSourceFiles,
} from './checks.ts'
import { withRequiredPackageDocs } from './checks-test-docs.ts'

// These tests run the real TypeScript language service (no mocks) so they
// prove what publish typecheck actually reports.

const packageTsconfig = JSON.stringify({
	compilerOptions: {
		allowImportingTsExtensions: true,
		module: 'esnext',
		moduleResolution: 'bundler',
		target: 'es2022',
		strict: true,
		noEmit: true,
	},
})

function createManifest(input: {
	exports?: Record<string, string | { import?: string; types?: string }>
	jobs?: Record<string, { entry: string; schedule: Record<string, unknown> }>
}) {
	return JSON.stringify({
		name: '@kody/typecheck-fixture',
		exports: input.exports ?? { '.': './src/index.ts' },
		kody: {
			id: 'typecheck-fixture',
			description: 'Typecheck fixture package',
			jobs: input.jobs,
		},
	})
}

async function runTypecheck(entries: Record<string, string>) {
	const files = withRequiredPackageDocs(new Map(Object.entries(entries)))
	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
	})
	const typecheck = result.results.find((entry) => entry.kind === 'typecheck')
	if (!typecheck) throw new Error('Expected a typecheck result.')
	return typecheck
}

test('export-only packages with a tsconfig fail publish typecheck on type errors in exported code', async () => {
	const typecheck = await runTypecheck({
		'package.json': createManifest({}),
		'tsconfig.json': packageTsconfig,
		'src/index.ts': 'export const answer: number = "forty-two"\n',
	})
	expect(typecheck).toEqual({
		kind: 'typecheck',
		ok: false,
		message:
			"src/index.ts:1:14 Type 'string' is not assignable to type 'number'.",
	})
})

test('publish typecheck follows exported code into reachable local modules only', async () => {
	const typecheck = await runTypecheck({
		'package.json': createManifest({}),
		'tsconfig.json': packageTsconfig,
		'src/index.ts': `import { z } from 'zod'
import { createRouter } from 'remix/router'
import other from 'kody:@kody/other-package/thing'
import { AsyncLocalStorage } from 'node:async_hooks'
import { packageStorage } from 'kody:runtime'
import { helper } from './helper.ts'
import type { Shape } from './types.ts'

export const shape: Shape = { label: helper() }
export const deps = { z, createRouter, other, AsyncLocalStorage, packageStorage }
`,
		'src/helper.ts': 'export const helper = (): string => 42\n',
		'src/types.ts':
			'export type Shape = { label: string }\nconst unused: number = "x"\n',
		'src/unreachable.ts': 'const ignored: number = "not imported"\n',
	})
	expect(typecheck.ok).toBe(false)
	expect(typecheck.message.split('\n')).toEqual([
		"src/helper.ts:1:37 Type 'number' is not assignable to type 'string'.",
		"src/types.ts:2:7 Type 'string' is not assignable to type 'number'.",
	])
})

test('export modules with only named exports pass publish typecheck', async () => {
	const typecheck = await runTypecheck({
		'package.json': createManifest({
			exports: { '.': './src/index.ts', './format': './src/format.ts' },
		}),
		'tsconfig.json': packageTsconfig,
		'src/index.ts': 'export const ready: boolean = true\n',
		'src/format.ts':
			'export function formatName(name: string) {\n  return name.trim()\n}\n',
	})
	expect(typecheck).toEqual({
		kind: 'typecheck',
		ok: true,
		message:
			'No semantic diagnostics for 2 package runtime entrypoint(s) across 2 reachable source file(s).',
	})
})

test('export types targets are typechecked alongside the runtime entry', async () => {
	const typecheck = await runTypecheck({
		'package.json': createManifest({
			exports: {
				'.': { import: './src/index.ts', types: './src/index.types.ts' },
				'./contract': { types: './src/contract.ts' },
			},
		}),
		'tsconfig.json': packageTsconfig,
		'src/index.ts': 'export default async () => ({ ok: true })\n',
		'src/index.types.ts':
			'/** Runs the package. */\nexport declare function run(): Promise<{ ok: boolean }>\nexport const broken: string = 1\n',
		'src/contract.ts': 'export type Contract = { id: MissingType }\n',
	})
	expect(typecheck.ok).toBe(false)
	expect(typecheck.message.split('\n')).toEqual([
		"src/contract.ts:1:30 Cannot find name 'MissingType'.",
		"src/index.types.ts:3:14 Type 'number' is not assignable to type 'string'.",
	])
})

test('an empty tsconfig still typechecks with TypeScript strict defaults', async () => {
	const typecheck = await runTypecheck({
		'package.json': createManifest({}),
		'tsconfig.json': '{}',
		'src/index.ts': 'export function greet(name) {\n  return `hi ${name}`\n}\n',
	})
	expect(typecheck).toEqual({
		kind: 'typecheck',
		ok: false,
		message: "src/index.ts:1:23 Parameter 'name' implicitly has an 'any' type.",
	})
})

test('job bodies with a tsconfig are typechecked, not only their default-export contract', async () => {
	const typecheck = await runTypecheck({
		'package.json': createManifest({
			jobs: {
				nightly: {
					entry: 'src/job.ts',
					schedule: { type: 'once', runAt: '2026-04-17T15:00:00Z' },
				},
			},
		}),
		'tsconfig.json': packageTsconfig,
		'src/index.ts': 'export const ready = true\n',
		'src/job.ts':
			'export default async () => {\n  const count: number = "one"\n  return count\n}\n',
	})
	expect(typecheck).toEqual({
		kind: 'typecheck',
		ok: false,
		message: "src/job.ts:2:9 Type 'string' is not assignable to type 'number'.",
	})
})

test('without a tsconfig, publish discloses that exports are not typechecked', async () => {
	const typecheck = await runTypecheck({
		'package.json': createManifest({}),
		'src/index.ts': 'export const answer: number = "forty-two"\n',
	})
	expect(typecheck).toEqual({
		kind: 'typecheck',
		ok: true,
		message:
			'Package source files, including package.json exports, are not typechecked: add a root tsconfig.json to typecheck every TypeScript file reachable from exports, jobs, subscription handlers, and retrievers.',
	})
})

test('runtime rebuild typecheck of published source only verifies the callable contract', async () => {
	const result = await typecheckPackageEntrypointsFromSourceFiles({
		sourceFiles: {
			'package.json': createManifest({}),
			'tsconfig.json': packageTsconfig,
			'src/index.ts':
				'const answer: number = "forty-two"\nexport default async () => answer\n',
		},
		entryPoints: [{ path: 'src/index.ts' }],
	})
	expect(result).toEqual({
		ok: true,
		message: 'No semantic diagnostics for 1 package runtime entrypoint(s).',
	})
})
