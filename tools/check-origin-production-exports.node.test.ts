import { expect, test } from 'vitest'
import {
	checkOriginProductionExports,
	checkOriginProductionExportsInRepo,
	extractNamedExports,
	type OriginProductionExportsCheckResult,
} from './check-origin-production-exports.ts'

const configPath = 'packages/worker/wrangler.jsonc'

function createConfig(overrides: {
	productionDurableObjects?: Array<Record<string, unknown>>
	productionMain?: unknown
	previewMain?: unknown
	testMain?: unknown
	topLevelMain?: unknown
	testDurableObjects?: Array<Record<string, unknown>>
}) {
	const preview: Record<string, unknown> = {}
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
				main: overrides.productionMain ?? './src/production-worker.ts',
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

test('rejects the production entry exporting a locally-owned class', () => {
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
			'exports "Mailbox", a Durable Object/workflow class env.test owns only locally',
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

test('rejects a top-level or env.production main that does not match the expected entries', () => {
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

	const wrongProduction = checkOriginProductionExports({
		configPath,
		config: createConfig({ productionMain: './src/index.ts' }),
		devEntrySource,
		productionEntrySource,
	})
	expect(wrongProduction.ok).toBe(false)
	expect(wrongProduction.errors).toEqual([
		expect.stringContaining('env.production.main is "./src/index.ts"'),
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

test('current repository origin production/dev-test-preview split passes the guardrail', async () => {
	const result: OriginProductionExportsCheckResult =
		await checkOriginProductionExportsInRepo()
	expect(result).toEqual({ ok: true, errors: [] })
})
