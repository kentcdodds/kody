import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCpythonExecute } from './cpython-runner.mjs'

const evalDir = path.dirname(fileURLToPath(import.meta.url))
const modelId = process.argv[2]
if (!modelId) {
	console.error('Usage: node run-model-eval.mjs <model-id>')
	process.exit(1)
}

const attemptsDir = path.join(evalDir, 'attempts', modelId)
const resultsDir = path.join(evalDir, 'results')
await mkdir(resultsDir, { recursive: true })

const suite = JSON.parse(
	await readFile(path.join(evalDir, 'tasks.json'), 'utf8'),
)

const MAX_RETRIES = 2

function normalizeLanguageSpec(value, taskGolden) {
	if (typeof value === 'string') {
		return {
			solution: value,
			expect: 'value',
			golden: taskGolden,
			taxonomy: null,
		}
	}
	return {
		solution: value.solution,
		expect: value.expect ?? 'value',
		golden: value.golden ?? taskGolden,
		taxonomy: value.taxonomy ?? null,
	}
}

function createFixture(seed) {
	const notes = new Map()
	for (const note of seed?.notes ?? []) {
		notes.set(note.id, note.text)
	}
	return {
		async call(name, args) {
			if (name === 'notes.write') {
				notes.set(String(args.id), String(args.text))
				return { id: args.id }
			}
			if (name === 'notes.remove') {
				notes.delete(String(args.id))
				return { removed: true }
			}
			if (name === 'notes.list') {
				return {
					notes: [...notes.entries()]
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([id, text]) => ({ id, text })),
				}
			}
			if (name === 'notes.get') {
				const text = notes.get(String(args.id))
				if (text === undefined) {
					throw new Error(`note missing: ${String(args.id)}`)
				}
				return { id: args.id, text }
			}
			if (name === 'search') {
				return { hits: [{ id: 'b', title: 'world' }] }
			}
			if (name === 'http.get') {
				return { status: 200, json: { ok: true, value: 3 } }
			}
			throw new Error(`Unknown capability: ${name}`)
		},
	}
}

function grade(spec, outcome) {
	if (spec.expect === 'failure') {
		return outcome.ok === false && outcome.taxonomy === spec.taxonomy
	}
	return (
		outcome.ok === true &&
		JSON.stringify(outcome.result) === JSON.stringify(spec.golden)
	)
}

async function runTypeScriptSolution(source, params, seed) {
	const startedAtMs = Date.now()
	const fixture = createFixture(seed)
	const stripped = source.replace(
		/import\s+\{\s*kody\s*\}\s+from\s+'kody:runtime'\s*/g,
		'',
	)
	const nonce = `${Date.now()}-${Math.random()}`
	const href = `data:text/javascript,${encodeURIComponent(
		`const kody = globalThis.__kodyEvalBridge\n${stripped}\n// ${nonce}\n`,
	)}`
	globalThis.__kodyEvalBridge = { call: fixture.call }
	try {
		const mod = await import(href)
		const result = await mod.default(params)
		return {
			ok: true,
			result,
			error: null,
			taxonomy: null,
			elapsedMs: Date.now() - startedAtMs,
			cpuMs: null,
			codeChars: source.length,
			logs: [],
		}
	} catch (cause) {
		return {
			ok: false,
			error: cause instanceof Error ? cause.message : String(cause),
			taxonomy: 'runtime',
			elapsedMs: Date.now() - startedAtMs,
			cpuMs: null,
			codeChars: source.length,
			logs: [],
		}
	}
}

async function runTask(task, language) {
	const spec = normalizeLanguageSpec(task[language], task.golden)
	const solutionFile =
		language === 'python' ? `${task.id}.py` : `${task.id}.mjs`
	const solutionPath = path.join(attemptsDir, solutionFile)
	const source = await readFile(solutionPath, 'utf8')
	const startedAtMs = Date.now()
	let outcome
	try {
		outcome =
			language === 'python'
				? await runCpythonExecute({
						source,
						params: task.params,
						call: createFixture(task.seed).call,
					})
				: await runTypeScriptSolution(source, task.params, task.seed)
	} catch (cause) {
		outcome = {
			ok: false,
			error: cause instanceof Error ? cause.message : String(cause),
			taxonomy: 'runtime',
			elapsedMs: Date.now() - startedAtMs,
			cpuMs: null,
			codeChars: source.length,
			logs: [],
		}
	}
	const passed = grade(spec, outcome)
	return {
		model: modelId,
		language,
		taskId: task.id,
		passed,
		retries: 0,
		codeChars: outcome.codeChars ?? source.length,
		elapsedMs: outcome.elapsedMs,
		taxonomy: outcome.taxonomy ?? null,
		error: outcome.ok === true ? null : (outcome.error ?? null),
	}
}

const runs = []
for (const task of suite.tasks) {
	for (const language of ['python', 'typescript']) {
		const result = await runTask(task, language)
		const label = result.passed ? '✓' : '✗'
		console.error(
			`${label} ${result.taskId} [${language}]${result.error ? ` — ${result.error}` : ''}`,
		)
		runs.push(result)
	}
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0
		? (sorted[mid - 1] + sorted[mid]) / 2
		: sorted[mid]
}

function summaryByLanguage(rows) {
	const passed = rows.filter((r) => r.passed).length
	const total = rows.length
	const chars = rows.map((r) => r.codeChars)
	return {
		passed,
		total,
		passRate: `${passed}/${total}`,
		medianCodeChars: median(chars),
		totalCodeChars: chars.reduce((s, c) => s + c, 0),
	}
}

const pyRuns = runs.filter((r) => r.language === 'python')
const tsRuns = runs.filter((r) => r.language === 'typescript')
const pySummary = summaryByLanguage(pyRuns)
const tsSummary = summaryByLanguage(tsRuns)

const report = {
	model: modelId,
	ranAt: new Date().toISOString(),
	runs,
	summary: {
		python: pySummary,
		typescript: tsSummary,
		pythonCheaper: pySummary.totalCodeChars < tsSummary.totalCodeChars,
		pythonBetter: pySummary.passed > tsSummary.passed,
		verdict:
			pySummary.passed > tsSummary.passed
				? 'Python produced more passing solutions'
				: pySummary.passed < tsSummary.passed
					? 'TypeScript produced more passing solutions'
					: pySummary.totalCodeChars < tsSummary.totalCodeChars
						? 'Tied on pass rate; Python is more concise'
						: 'Tied on pass rate; TypeScript is more concise or equal',
	},
}

const outPath = path.join(resultsDir, `${modelId}.json`)
await writeFile(outPath, JSON.stringify(report, null, '\t') + '\n')
console.error(`\nResults written to ${outPath}`)
process.stdout.write(JSON.stringify(report, null, '\t') + '\n')
