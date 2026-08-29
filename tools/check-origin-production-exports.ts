import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { parseJsonc } from './ci/resource-utils.ts'
import { isExecutedDirectly } from './node-runtime.ts'

export const defaultWranglerConfigPath = path.join(
	'packages',
	'worker',
	'wrangler.jsonc',
)
export const defaultDevEntryPath = './src/index.ts'
export const defaultProductionEntryPath = './src/production-worker.ts'

/**
 * The only two `ctx.exports` WorkerEntrypoint contracts production actually
 * calls on its own script (see the doc comment on
 * `packages/worker/src/production-worker.ts`). Every other class
 * `index.ts` exports is reached in production only through a cross-script
 * binding (`script_name`) or the `RUNTIME_WORKER` service forward, so the
 * production entry must export exactly this set — nothing more, nothing
 * less.
 */
export const productionExportAllowlist = ['JobsHost', 'KodyFetchGateway']

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
 * Every top-level `export { A, B as C }` block, plus `export const/class/
 * function X` declarations. Parsed with the TypeScript compiler API (not
 * regex) so comments, string/template literals, and nested scopes that
 * merely *contain* export-shaped text (for example a docstring quoting
 * `export { Mailbox }`) can never be mistaken for a real export.
 */
export function extractNamedExports(source: string): Array<string> {
	const sourceFile = ts.createSourceFile(
		'origin-entry.ts',
		source,
		ts.ScriptTarget.Latest,
		false,
		ts.ScriptKind.TS,
	)
	const names = new Set<string>()

	const hasExportModifier = (node: ts.Node) =>
		ts.canHaveModifiers(node) &&
		ts
			.getModifiers(node)
			?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
			true

	for (const statement of sourceFile.statements) {
		if (ts.isExportDeclaration(statement)) {
			if (statement.isTypeOnly) continue
			const clause = statement.exportClause
			if (clause && ts.isNamedExports(clause)) {
				for (const element of clause.elements) {
					if (element.isTypeOnly) continue
					names.add(element.name.text)
				}
			}
			continue
		}

		if (!hasExportModifier(statement)) continue

		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) {
					names.add(declaration.name.text)
				}
			}
			continue
		}

		if (
			(ts.isClassDeclaration(statement) ||
				ts.isFunctionDeclaration(statement)) &&
			statement.name
		) {
			names.add(statement.name.text)
		}
	}

	return [...names]
}

/**
 * `export * from "./module"` forwards every runtime named export. The
 * production entry allowlist cannot see those names, so the checker
 * rejects export-star instead of treating the file as empty.
 */
export function hasExportStarDeclaration(source: string): boolean {
	const sourceFile = ts.createSourceFile(
		'origin-entry.ts',
		source,
		ts.ScriptTarget.Latest,
		false,
		ts.ScriptKind.TS,
	)
	return sourceFile.statements.some((statement) => {
		if (!ts.isExportDeclaration(statement)) return false
		if (statement.isTypeOnly) return false
		return Boolean(statement.moduleSpecifier) && statement.exportClause == null
	})
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

function classNamesOf(bindings: ReadonlyArray<ClassBinding>) {
	return [...new Set(bindings.map((binding) => binding.class_name))].sort()
}

/**
 * Guards the origin production/dev-test-preview entry split (ADR 0034):
 *
 * - `env.production` must bind every Durable Object/workflow class
 *   cross-script (`script_name`); a binding without one means production
 *   would locally own the class again, which requires exporting it from the
 *   production entry.
 * - The production entry must export exactly `productionExportAllowlist` —
 *   no more, no less. `env.production.main` itself is deploy-generated only
 *   (see `tools/ci/production-resources.ts`) and is never required or
 *   checked here.
 * - The dev/test/preview entry must export every class `env.test` binds
 *   locally, plus every class `env.preview` binds at all (regardless of
 *   `script_name`): preview's fresh-per-PR bootstrap deploy briefly strips
 *   `script_name` from the platform/runtime-owned bindings so its
 *   self-contained first deploy still finds every class locally (see
 *   `tools/ci/platform-worker-config.ts` / `runtime-worker-config.ts`), so
 *   every preview-bound class is a bootstrap candidate whether or not the
 *   committed config currently cross-scripts it.
 * - No committed environment may override `main`. Production's slim entry is
 *   applied only to the generated deploy config; local production-mode dev,
 *   preview, and test all inherit the top-level dev/test/preview entry.
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
	const previewEnv = envRecord.preview
	const previewBindings = collectClassBindings(previewEnv)
	// Every class env.test binds locally, union every class env.preview
	// binds at all (see the preview-bootstrap note in the function
	// docstring) — the dev/test/preview entry must export all of them.
	const requiredDevClassNames = classNamesOf([
		...testBindings,
		...previewBindings,
	])

	const devExports = new Set(extractNamedExports(input.devEntrySource))
	const productionExportsList = extractNamedExports(input.productionEntrySource)
	const productionExports = new Set(productionExportsList)
	if (hasExportStarDeclaration(input.productionEntrySource)) {
		errors.push(
			`${productionEntryPath}: must not use export * (the production allowlist cannot see star-forwarded runtime names).`,
		)
	}

	for (const className of requiredDevClassNames) {
		if (!devExports.has(className)) {
			errors.push(
				`${devEntryPath}: does not export "${className}", but env.test or env.preview binds it (including as a preview-bootstrap candidate) in ${input.configPath}. The dev/test/preview entry must export every locally-owned or bootstrap-candidate Durable Object/workflow class.`,
			)
		}
	}

	const allowlist = new Set(productionExportAllowlist)
	const missingAllowlisted = productionExportAllowlist.filter(
		(name) => !productionExports.has(name),
	)
	const unexpectedExports = productionExportsList
		.filter((name) => !allowlist.has(name))
		.sort()
	if (missingAllowlisted.length > 0 || unexpectedExports.length > 0) {
		const parts: Array<string> = []
		if (missingAllowlisted.length > 0) {
			parts.push(`missing ${missingAllowlisted.join(', ')}`)
		}
		if (unexpectedExports.length > 0) {
			parts.push(`unexpected ${unexpectedExports.join(', ')}`)
		}
		errors.push(
			`${productionEntryPath}: must export exactly ${productionExportAllowlist.join(', ')} (${parts.join('; ')}).`,
		)
	}

	const previewMain =
		previewEnv && typeof previewEnv === 'object'
			? (previewEnv as Record<string, unknown>).main
			: undefined
	if (previewMain !== undefined) {
		errors.push(
			`${input.configPath}: env.preview.main is set (${JSON.stringify(previewMain)}); env.preview must inherit the top-level "main" (${devEntryPath}) so its bootstrap deploy keeps every locally-owned class exported.`,
		)
	}

	const productionMain = (productionEnv as Record<string, unknown>).main
	if (productionMain !== undefined) {
		errors.push(
			`${input.configPath}: env.production.main is set (${JSON.stringify(productionMain)}); the slim production entry is deploy-generated only so local production-mode dev must inherit the top-level "main" (${devEntryPath}).`,
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
		'Origin production export check ok: production exports exactly the allowlisted entrypoints, owns zero local Durable Object/workflow classes, and the dev/test/preview entry still exports every locally-owned or preview-bootstrap-candidate class.',
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
