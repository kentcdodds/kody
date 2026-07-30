import {
	hasTopLevelDefaultExport,
	parseModuleSource,
} from '#worker/module-source.ts'

const entryPath = 'entry.ts'
const maxExecuteTypecheckSourceBytes = 512 * 1024

/**
 * The pre-execution check deliberately runs no TypeScript compiler and loads
 * no package sources. Earlier revisions ran full LanguageService semantic
 * diagnostics (with published package type graphs) inside the MCP isolate;
 * production showed that is unsurvivable there: the compiler's cold start
 * (multi-MB dynamic import plus a TypeScript lib tarball fetch, decompress,
 * and parse) blocks the isolate event loop and spikes memory toward the
 * 128MB Workers limit, and package graphs cost ~100x their source bytes in
 * program memory. An isolate kill aborts every in-flight execute with no
 * error path — MCP calls hang until the client deadline and eager run
 * records strand as `running` until the stale TTL reconciles them as
 * Interrupted, session-affine because MCP conversations pin to one Durable
 * Object isolate. Semantic checking belongs in its own isolate (for example
 * a Worker Loader dynamic worker); until that exists, the pre-exec check is
 * a bounded syntax and module-shape gate built on the same Babel parser the
 * bundler already uses on this path.
 */
export class ExecuteTypecheckError extends Error {
	readonly diagnostics: Array<string>
	serverTiming: Array<ExecuteServerTimingEntry> | undefined

	constructor(diagnostics: Array<string>) {
		super(
			`Ad hoc execute TypeScript check failed:\n${diagnostics
				.map((diagnostic) => `- ${diagnostic}`)
				.join('\n')}`,
		)
		this.name = 'ExecuteTypecheckError'
		this.diagnostics = diagnostics
	}
}

/**
 * Server-Timing-style phase entry (`name` + `durationMs`) surfaced through the
 * execute tool's structured response so agents can attribute latency.
 */
export type ExecuteServerTimingEntry = {
	name: string
	durationMs: number
}

function assertEntrySourceWithinLimits(source: string) {
	const sourceBytes = new TextEncoder().encode(source).byteLength
	if (sourceBytes > maxExecuteTypecheckSourceBytes) {
		throw new ExecuteTypecheckError([
			`entry.ts exceeds the ${maxExecuteTypecheckSourceBytes}-byte pre-execution TypeScript source limit.`,
		])
	}
}

function formatParseDiagnostic(error: unknown) {
	const location = (
		error as { loc?: { line?: unknown; column?: unknown } | null }
	).loc
	const message =
		error instanceof Error
			? // Babel appends " (line:column)" to the message; the structured
				// location below already carries it.
				error.message.replace(/\s*\(\d+:\d+\)$/, '')
			: String(error)
	if (
		typeof location?.line === 'number' &&
		typeof location.column === 'number'
	) {
		return `${entryPath}:${location.line}:${location.column + 1} ${message}`
	}
	return `${entryPath} ${message}`
}

/**
 * Validate an ad hoc execute module before run records are claimed and the
 * sandbox spins up: source size, module syntax (TypeScript-aware parse), and
 * the presence of the default export the execute runtime requires. Returns
 * Server-Timing phases; throws {@link ExecuteTypecheckError} with
 * `entry.ts:line:column`-prefixed diagnostics on failure.
 */
export async function assertAdHocExecuteTypechecks(input: {
	source: string
}): Promise<Array<ExecuteServerTimingEntry>> {
	const startedAtMs = Date.now()
	const entries: Array<ExecuteServerTimingEntry> = [
		// Explicit marker that semantic (type-level) checking did not run; see
		// the module docstring for why it cannot run in this isolate.
		{ name: 'typecheck-semantic-skipped', durationMs: 0 },
	]
	const finish = () => {
		entries.push({
			name: 'typecheck-total',
			durationMs: Date.now() - startedAtMs,
		})
		return entries
	}
	try {
		assertEntrySourceWithinLimits(input.source)
		const parseStartedAtMs = Date.now()
		try {
			parseModuleSource(input.source)
		} finally {
			entries.push({
				name: 'typecheck-parse',
				durationMs: Date.now() - parseStartedAtMs,
			})
		}
		if (!hasTopLevelDefaultExport(input.source)) {
			throw new ExecuteTypecheckError([
				`${entryPath} Module must have a default export; the execute runtime calls the default-exported function.`,
			])
		}
		return finish()
	} catch (error) {
		if (error instanceof ExecuteTypecheckError) {
			finish()
			error.serverTiming = [...entries]
			throw error
		}
		const wrapped = new ExecuteTypecheckError([formatParseDiagnostic(error)])
		finish()
		wrapped.serverTiming = [...entries]
		throw wrapped
	}
}
