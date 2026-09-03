import { expect, test } from 'vitest'
import {
	checkOriginProductionExports,
	checkOriginProductionExportsInRepo,
	extractNamedExports,
	hasExportStarDeclaration,
	type OriginProductionExportsCheckResult,
} from './check-origin-production-exports.ts'

const configPath = 'packages/worker/wrangler.jsonc'

function createConfig(overrides: {
	productionDurableObjects?: Array<Record<string, unknown>>
	previewMain?: unknown
	testMain?: unknown
	topLevelMain?: unknown
	testDurableObjects?: Array<Record<string, unknown>>
	previewDurableObjects?: Array<Record<string, unknown>>
}) {
	const preview: Record<string, unknown> = {
		durable_objects: {
			bindings: overrides.previewDurableObjects ?? [
				{
					name: 'MAILBOX',
					class_name: 'Mailbox',
					script_name: 'kody-platform',
				},
			],
		},
	}
	if (overrides.previewMain !== undefined) preview.main = overrides.previewMain

	const test: Record<string, unknown> = {
		durable_objects: {
			bindings: overrides.testDurableObjects ?? [
				{ name: 'MAILBOX', class_name: 'Mailbox' },
			],
		},
	}
	if (overrides.testMain !== undefined) test.main = overrides.testMain

	return {
		main: overrides.topLevelMain ?? './src/index.ts',
		env: {
			production: {
				durable_objects: {
					bindings: overrides.productionDurableObjects ?? [
						{
							name: 'MAILBOX',
							class_name: 'Mailbox',
							script_name: 'kody-platform',
						},
					],
				},
			},
			preview,
			test,
		},
	}
}

const devEntrySource = `
export {
	Mailbox,
	KodyFetchGateway,
	JobsHost,
}
export default originWorkerHandler
`

const productionEntrySource = `
export { KodyFetchGateway, JobsHost }
export default originWorkerHandler
`

test('accepts the checked-in production/dev-test-preview split', () => {
	const result = checkOriginProductionExports({
		configPath,
		config: createConfig({}),
		devEntrySource,
		productionEntrySource,
	})
	expect(result).toEqual({ ok: true, errors: [] })
})

test('rejects a production Durable Object binding without script_name', () => {
	const result = checkOriginProductionExports({
		configPath,
		config: createConfig({
			productionDurableObjects: [{ name: 'MAILBOX', class_name: 'Mailbox' }],
		}),
		devEntrySource,
		productionEntrySource,
	})
	expect(result.ok).toBe(false)
	expect(result.errors).toEqual([
		expect.stringContaining(
			'env.production binds "Mailbox" without a script_name',
		),
	])
})

test('rejects the production entry exporting a class outside the allowlist', () => {
	const result = checkOriginProductionExports({
		configPath,
		config: createConfig({}),
		devEntrySource,
		productionEntrySource: `
export { Mailbox, KodyFetchGateway, JobsHost }
export default originWorkerHandler
`,
	})
	expect(result.ok).toBe(false)
	expect(result.errors).toEqual([
		expect.stringContaining(
			'must export exactly JobsHost, KodyFetchGateway (unexpected Mailbox)',
		),
	])
})

test('rejects the production entry missing an allowlisted export', () => {
	const result = checkOriginProductionExports({
		configPath,
		config: createConfig({}),
		devEntrySource,
		productionEntrySource: `
export { KodyFetchGateway }
export default originWorkerHandler
`,
	})
	expect(result.ok).toBe(false)
	expect(result.errors).toEqual([
		expect.stringContaining(
			'must export exactly JobsHost, KodyFetchGateway (missing JobsHost)',
		),
	])
})

test('rejects a dev entry missing a class env.test owns locally', () => {
	const result = checkOriginProductionExports({
		configPath,
		config: createConfig({}),
		devEntrySource: `
export { KodyFetchGateway, JobsHost }
export default originWorkerHandler
`,
		productionEntrySource,
	})
	expect(result.ok).toBe(false)
	expect(result.errors).toEqual([
		expect.stringContaining('does not export "Mailbox"'),
	])
})

test('rejects a preview Durable Object binding without script_name', () => {
	// Preview uploads the same slim entry as production
	// (tools/ci/preview-resources.ts), so a locally-owned preview binding
	// would need a class the slim entry does not export.
	const result = checkOriginProductionExports({
		configPath,
		config: createConfig({
			previewDurableObjects: [
				{ name: 'STORAGE_RUNNER', class_name: 'StorageRunner' },
			],
		}),
		devEntrySource: `
export { Mailbox, StorageRunner, KodyFetchGateway, JobsHost }
export default originWorkerHandler
`,
		productionEntrySource,
	})
	expect(result.ok).toBe(false)
	expect(result.errors).toEqual([
		expect.stringContaining(
			'env.preview binds "StorageRunner" without a script_name',
		),
	])
})

test('does not require the dev entry to export a class env.preview only binds cross-script', () => {
	const result = checkOriginProductionExports({
		configPath,
		config: createConfig({
			testDurableObjects: [],
			previewDurableObjects: [
				{
					name: 'STORAGE_RUNNER',
					class_name: 'StorageRunner',
					script_name: 'kody-runtime',
				},
			],
		}),
		devEntrySource: `
export { KodyFetchGateway, JobsHost }
export default originWorkerHandler
`,
		productionEntrySource,
	})
	expect(result).toEqual({ ok: true, errors: [] })
})

test('rejects env.preview or env.test overriding main', () => {
	const previewResult = checkOriginProductionExports({
		configPath,
		config: createConfig({ previewMain: './src/production-worker.ts' }),
		devEntrySource,
		productionEntrySource,
	})
	expect(previewResult.ok).toBe(false)
	expect(previewResult.errors).toEqual([
		expect.stringContaining('env.preview.main is set'),
	])

	const testResult = checkOriginProductionExports({
		configPath,
		config: createConfig({ testMain: './src/production-worker.ts' }),
		devEntrySource,
		productionEntrySource,
	})
	expect(testResult.ok).toBe(false)
	expect(testResult.errors).toEqual([
		expect.stringContaining('env.test.main is set'),
	])
})

test('rejects a top-level main that does not match the expected dev entry', () => {
	const wrongTopLevel = checkOriginProductionExports({
		configPath,
		config: createConfig({ topLevelMain: './src/other.ts' }),
		devEntrySource,
		productionEntrySource,
	})
	expect(wrongTopLevel.ok).toBe(false)
	expect(wrongTopLevel.errors).toEqual([
		expect.stringContaining('top-level "main" is "./src/other.ts"'),
	])
})

test('rejects a committed env.production.main because the slim entry is deploy-generated only', () => {
	const configWithMain = createConfig({}) as {
		env: { production: Record<string, unknown> }
	}
	configWithMain.env.production.main = './src/production-worker.ts'
	const result = checkOriginProductionExports({
		configPath,
		config: configWithMain,
		devEntrySource,
		productionEntrySource,
	})
	expect(result.ok).toBe(false)
	expect(result.errors).toEqual([
		expect.stringContaining(
			'env.production.main is set ("./src/production-worker.ts")',
		),
	])
})

test('extractNamedExports handles named blocks, aliases, and declaration exports', () => {
	expect(
		extractNamedExports(`
export { A, B as C }
export const D = 1
export class E {}
export function f() {}
export default E
`),
	).toEqual(expect.arrayContaining(['A', 'C', 'D', 'E', 'f']))
	expect(extractNamedExports('export default handler')).toEqual([])
})

test('extractNamedExports ignores type-only export declarations and specifiers', () => {
	expect(
		extractNamedExports(`
export type { TypeOnlyName }
export { type TypeOnlySpecifier, RuntimeName }
export { JobsHost }
`),
	).toEqual(['RuntimeName', 'JobsHost'])
})

test('hasExportStarDeclaration detects runtime export-star and ignores type-only stars', () => {
	expect(hasExportStarDeclaration('export * from "./index.ts"')).toBe(true)
	expect(hasExportStarDeclaration('export * as Legacy from "./index.ts"')).toBe(
		true,
	)
	expect(hasExportStarDeclaration('export type * from "./types.ts"')).toBe(
		false,
	)
	expect(hasExportStarDeclaration('export { JobsHost }')).toBe(false)
})

test('extractNamedExports ignores default and declare-only declarations', () => {
	expect(extractNamedExports('export default class JobsHost {}')).toEqual([])
	expect(extractNamedExports('export declare class JobsHost {}')).toEqual([])
	expect(extractNamedExports('export class JobsHost {}')).toEqual(['JobsHost'])
})

test('rejects a production entry that star-exports hidden runtime names', () => {
	const result = checkOriginProductionExports({
		configPath,
		config: createConfig({}),
		devEntrySource,
		productionEntrySource: `
export { KodyFetchGateway, JobsHost }
export * from "./index.ts"
export default originWorkerHandler
`,
	})
	expect(result.ok).toBe(false)
	expect(result.errors).toEqual([
		expect.stringContaining('must not use export *'),
	])

	const namespaceResult = checkOriginProductionExports({
		configPath,
		config: createConfig({}),
		devEntrySource,
		productionEntrySource: `
export { KodyFetchGateway, JobsHost }
export * as Legacy from "./index.ts"
export default originWorkerHandler
`,
	})
	expect(namespaceResult.ok).toBe(false)
	expect(namespaceResult.errors).toEqual([
		expect.stringContaining('must not use export *'),
	])
})

test('extractNamedExports parses with the TypeScript AST, ignoring export-shaped text in comments and strings', () => {
	const source = `
// export { ShouldNotCount }
/**
 * export { AlsoShouldNotCount }
 */
const trap = 'export { StillNotReal }'
const template = \`export { NeitherIsThis }\`
export { RealExport }
`
	expect(extractNamedExports(source)).toEqual(['RealExport'])
})

test('current repository origin production/dev-test-preview split passes the guardrail', async () => {
	const result: OriginProductionExportsCheckResult =
		await checkOriginProductionExportsInRepo()
	expect(result).toEqual({ ok: true, errors: [] })
})
