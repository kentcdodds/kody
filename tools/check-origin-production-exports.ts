import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonc } from './ci/resource-utils.ts'
import { isExecutedDirectly } from './node-runtime.ts'

export const defaultWranglerConfigPath = path.join(
	'packages',
	'worker',
	'wrangler.jsonc',
)
export const defaultDevEntryPath = './src/index.ts'
export const defaultProductionEntryPath = './src/production-worker.ts'

type WranglerConfig = {
	main?: unknown
	env?: unknown
	[key: string]: unknown
}

type ClassBinding = {
	class_name: string
	script_name?: string
}

export type OriginProductionExportsCheckResult = {
	ok: boolean
	errors: Array<string>
}

/**
 * Every `export { A, B as C }` block, plus `export const/class/function X`
 * declarations. `index.ts` and `production-worker.ts` only use the named
 * block form today; the declaration forms are included so this keeps
 * working if either entry switches style.
 */
export function extractNamedExports(source: string): Array<string> {
	const names = new Set<string>()

	const namedExportBlockPattern = /export\s*\{([^}]*)\}/g
	for (const match of source.matchAll(namedExportBlockPattern)) {
		const body = match[1] ?? ''
		for (const rawEntry of body.split(',')) {
			const entry = rawEntry.trim()
			if (!entry) continue
			const asMatch = /^(\w+)\s+as\s+(\w+)$/.exec(entry)
			if (asMatch?.[2]) {
				names.add(asMatch[2])
				continue
			}
			const identifierMatch = /^(\w+)$/.exec(entry)
			if (identifierMatch?.[1]) names.add(identifierMatch[1])
		}
	}

	const declarationExportPattern = /export\s+(?:const|class|function)\s+(\w+)/g
	for (const match of source.matchAll(declarationExportPattern)) {
		if (match[1]) names.add(match[1])
	}

	return [...names]
}

function collectClassBindings(envConfig: unknown): Array<ClassBinding> {
	if (!envConfig || typeof envConfig !== 'object') return []
	const config = envConfig as Record<string, unknown>
	const bindings: Array<ClassBinding> = []

	const durableObjects = config.durable_objects
	if (durableObjects && typeof durableObjects === 'object') {
		const list = (durableObjects as Record<string, unknown>).bindings
		if (Array.isArray(list)) {
			for (const entry of list) {
				if (!entry || typeof entry !== 'object') continue
				const candidate = entry as Record<string, unknown>
				if (typeof candidate.class_name === 'string') {
					bindings.push({
						class_name: candidate.class_name,
						...(typeof candidate.script_name === 'string'
							? { script_name: candidate.script_name }
							: {}),
					})
				}
			}
		}
	}

	const workflows = config.workflows
	if (Array.isArray(workflows)) {
		for (const entry of workflows) {
			if (!entry || typeof entry !== 'object') continue
			const candidate = entry as Record<string, unknown>
			if (typeof candidate.class_name === 'string') {
				bindings.push({
					class_name: candidate.class_name,
					...(typeof candidate.script_name === 'string'
						? { script_name: candidate.script_name }
						: {}),
				})
			}
		}
	}

	return bindings
}

/**
 * Guards the origin production/dev-test-preview entry split (ADR 0034):
 *
 * - `env.production` must bind every Durable Object/workflow class
 *   cross-script (`script_name`); a binding without one means production
 *   would locally own the class again, which requires exporting it from the
 *   production entry.
 * - The production entry must never export a class that `env.test` (full
 *   local ownership, no platform/runtime scripts to cross into) binds
 *   locally — that class belongs only to the dev/test/preview entry.
 * - The dev/test/preview entry must export every class `env.test` binds
 *   locally, so local dev, workers-unit, and Playwright keep working.
 * - Only `env.production` may override `main`; `env.preview` and `env.test`
 *   must keep inheriting the top-level dev/test/preview entry so preview's
 *   bootstrap deploy (which briefly strips `script_name`, see
 *   docs/contributing/architecture/platform-worker-migration-runbook.md and
 *   the runtime-worker counterpart) still finds every class it needs
 *   locally.
 */
export function checkOriginProductionExports(input: {
	configPath: string
	config: WranglerConfig
	devEntrySource: string
	productionEntrySource: string
	devEntryPath?: string
	productionEntryPath?: string
}): OriginProductionExportsCheckResult {
	const devEntryPath = input.devEntryPath ?? defaultDevEntryPath
	const productionEntryPath =
		input.productionEntryPath ?? defaultProductionEntryPath
	const errors: Array<string> = []

	const env = input.config.env
	if (!env || typeof env !== 'object') {
		return { ok: false, errors: [`${input.configPath}: missing "env".`] }
	}
	const envRecord = env as Record<string, unknown>
	const productionEnv = envRecord.production
	const testEnv = envRecord.test
	if (!productionEnv || typeof productionEnv !== 'object') {
		errors.push(`${input.configPath}: missing "env.production".`)
	}
	if (!testEnv || typeof testEnv !== 'object') {
		errors.push(`${input.configPath}: missing "env.test".`)
	}
	if (errors.length > 0) return { ok: false, errors }

	const productionBindings = collectClassBindings(productionEnv)
	for (const binding of productionBindings) {
		if (!binding.script_name) {
			errors.push(
				`${input.configPath}: env.production binds "${binding.class_name}" without a script_name, so production would locally own this Durable Object/workflow class (ADR 0034 violation). Either add script_name (kody-platform or kody-runtime) or export the class from ${productionEntryPath}.`,
			)
		}
	}

	const testBindings = collectClassBindings(testEnv)
	const testOwnedClassNames = [
		...new Set(testBindings.map((binding) => binding.class_name)),
	].sort()

	const devExports = new Set(extractNamedExports(input.devEntrySource))
	const productionExports = new Set(
		extractNamedExports(input.productionEntrySource),
	)

	for (const className of testOwnedClassNames) {
		if (!devExports.has(className)) {
			errors.push(
				`${devEntryPath}: does not export "${className}", but env.test binds it locally (no script_name) in ${input.configPath}. The dev/test/preview entry must export every locally-owned Durable Object/workflow class.`,
			)
		}
		if (productionExports.has(className)) {
			errors.push(
				`${productionEntryPath}: exports "${className}", a Durable Object/workflow class env.test owns only locally. env.production binds this class with script_name, so production must not export it (ADR 0034).`,
			)
		}
	}

	const productionMain = (productionEnv as Record<string, unknown>).main
	if (productionMain !== productionEntryPath) {
		errors.push(
			`${input.configPath}: env.production.main is ${JSON.stringify(productionMain)}, expected ${JSON.stringify(productionEntryPath)}.`,
		)
	}

	const previewEnv = envRecord.preview
	const previewMain =
		previewEnv && typeof previewEnv === 'object'
			? (previewEnv as Record<string, unknown>).main
			: undefined
	if (previewMain !== undefined) {
		errors.push(
			`${input.configPath}: env.preview.main is set (${JSON.stringify(previewMain)}); env.preview must inherit the top-level "main" (${devEntryPath}) so its bootstrap deploy keeps every locally-owned class exported.`,
		)
	}

	const testMain = (testEnv as Record<string, unknown>).main
	if (testMain !== undefined) {
		errors.push(
			`${input.configPath}: env.test.main is set (${JSON.stringify(testMain)}); env.test must inherit the top-level "main" (${devEntryPath}) so local dev/test/e2e keeps owning every Durable Object class it declares.`,
		)
	}

	const topLevelMain = input.config.main
	if (topLevelMain !== devEntryPath) {
		errors.push(
			`${input.configPath}: top-level "main" is ${JSON.stringify(topLevelMain)}, expected ${JSON.stringify(devEntryPath)} (env.test and env.preview inherit it).`,
		)
	}

	return { ok: errors.length === 0, errors }
}

export async function checkOriginProductionExportsInRepo(options?: {
	configPath?: string
	devEntryPath?: string
	productionEntryPath?: string
}): Promise<OriginProductionExportsCheckResult> {
	const configPath = options?.configPath ?? defaultWranglerConfigPath
	const devEntryPath = options?.devEntryPath ?? defaultDevEntryPath
	const productionEntryPath =
		options?.productionEntryPath ?? defaultProductionEntryPath

	const workerDir = path.dirname(configPath)
	const [configSource, devEntrySource, productionEntrySource] =
		await Promise.all([
			readFile(configPath, 'utf8'),
			readFile(path.join(workerDir, devEntryPath), 'utf8'),
			readFile(path.join(workerDir, productionEntryPath), 'utf8'),
		])

	return checkOriginProductionExports({
		configPath,
		config: parseJsonc<WranglerConfig>(configSource),
		devEntrySource,
		productionEntrySource,
		devEntryPath,
		productionEntryPath,
	})
}

export async function main(): Promise<void> {
	const result = await checkOriginProductionExportsInRepo()
	if (!result.ok) {
		console.error(
			`Origin production export check failed (${String(result.errors.length)} issue(s)):`,
		)
		for (const error of result.errors) console.error(`  - ${error}`)
		process.exitCode = 1
		return
	}
	console.log(
		'Origin production export check ok: production owns zero local Durable Object/workflow classes and the dev/test/preview entry still exports every locally-owned class.',
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
