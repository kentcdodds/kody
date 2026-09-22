import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCpythonExecute } from './cpython-runner.mjs'

const evalDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * Reference-solution bakeoff. Prints one JSON report.
 *
 * TypeScript rows run in Node with a kody.call bridge, the same shape an
 * agent sends to MCP execute (import { kody } from 'kody:runtime').
 * Python rows run on local CPython through sandbox-harness.py.
 * Preview Python runs use MCP execute language=python (Worker Loader),
 * which this script does not call.
 */
const suite = JSON.parse(
	await readFile(path.join(evalDir, 'tasks.json'), 'utf8'),
)

const runs = []
for (const task of suite.tasks) {
	for (const language of ['python', 'typescript']) {
		runs.push(await runTask(task, language))
	}
}

const report = {
	suite: suite.suite,
	backend: {
		python: 'cpython',
		typescript: 'node',
	},
	ranAt: new Date().toISOString(),
	runs,
	summary: summarize(runs),
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (report.summary.failed > 0) process.exitCode = 1

async function runTask(task, language) {
	const spec = normalizeLanguageSpec(task[language], task.golden)
	const source = await readFile(path.join(evalDir, spec.solution), 'utf8')
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
		taskId: task.id,
		category: task.category,
		language,
		passed,
		executionOk: outcome.ok === true,
		elapsedMs: outcome.elapsedMs,
		cpuMs: outcome.cpuMs ?? null,
		codeChars: outcome.codeChars ?? source.length,
		retries: 0,
		taxonomy: outcome.taxonomy ?? null,
		error: outcome.ok === true ? null : (outcome.error ?? null),
		goldenMismatch: spec.expect === 'value' && outcome.ok === true && !passed,
	}
}

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

function grade(spec, outcome) {
	if (spec.expect === 'failure') {
		return outcome.ok === false && outcome.taxonomy === spec.taxonomy
	}
	return (
		outcome.ok === true &&
		JSON.stringify(outcome.result) === JSON.stringify(spec.golden)
	)
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

function summarize(rows) {
	const byLanguage = {}
	for (const language of ['python', 'typescript']) {
		const group = rows.filter((row) => row.language === language)
		const elapsed = group
			.map((row) => row.elapsedMs)
			.sort((left, right) => left - right)
		byLanguage[language] = {
			passed: group.filter((row) => row.passed).length,
			failed: group.filter((row) => !row.passed).length,
			totalCodeChars: group.reduce((sum, row) => sum + row.codeChars, 0),
			medianElapsedMs: elapsed[Math.floor(elapsed.length / 2)] ?? 0,
		}
	}
	return {
		passed: rows.filter((row) => row.passed).length,
		failed: rows.filter((row) => !row.passed).length,
		byLanguage,
	}
}
