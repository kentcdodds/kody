/**
 * Agent-authored eval runner for claude-sonnet-4-6.
 * Reads solutions from agent-solutions/claude-sonnet-4-6/,
 * supports up to 2 retries per (task, language) via *.retry1.* and *.retry2.* files,
 * and writes results to results/claude-sonnet-4-6.json.
 */
import { readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCpythonExecute } from './cpython-runner.mjs'

const MODEL_ID = 'claude-sonnet-4-6'
const evalDir = path.dirname(fileURLToPath(import.meta.url))
const solutionsDir = path.join(evalDir, 'agent-solutions', MODEL_ID)
const resultsDir = path.join(evalDir, 'results')
const resultsPath = path.join(resultsDir, `${MODEL_ID}.json`)

const suite = JSON.parse(
	await readFile(path.join(evalDir, 'tasks.json'), 'utf8'),
)

const runs = []
for (const task of suite.tasks) {
	for (const language of ['python', 'typescript']) {
		const row = await runTaskWithRetries(task, language)
		runs.push(row)
	}
}

const report = {
	model: MODEL_ID,
	suite: suite.suite,
	backend: { python: 'cpython', typescript: 'node' },
	ranAt: new Date().toISOString(),
	runs,
	summary: summarize(runs),
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
await writeFile(resultsPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
process.stderr.write(`\nResults written to ${resultsPath}\n`)
if (report.summary.failed > 0) process.exitCode = 1

/** Try the base solution then up to two retry variants. */
async function runTaskWithRetries(task, language) {
	const ext = language === 'python' ? 'py' : 'mjs'
	const spec = normalizeSpec(task[language], task.golden)
	const baseName = task.id

	const attempts = [
		path.join(solutionsDir, `${baseName}.${ext}`),
		path.join(solutionsDir, `${baseName}.retry1.${ext}`),
		path.join(solutionsDir, `${baseName}.retry2.${ext}`),
	]

	let lastRow = null
	for (let attempt = 0; attempt < attempts.length; attempt++) {
		const filePath = attempts[attempt]
		if (!(await exists(filePath))) break

		const source = await readFile(filePath, 'utf8')
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
				codeChars: source.length,
			}
		}

		const passed = grade(spec, outcome)
		lastRow = {
			model: MODEL_ID,
			language,
			taskId: task.id,
			category: task.category,
			passed,
			retries: attempt,
			codeChars: outcome.codeChars ?? source.length,
			elapsedMs: outcome.elapsedMs,
			...(outcome.taxonomy != null ? { taxonomy: outcome.taxonomy } : {}),
			...(outcome.ok === false ? { error: outcome.error ?? null } : {}),
		}

		if (passed) break
	}

	if (lastRow === null) {
		return {
			model: MODEL_ID,
			language,
			taskId: task.id,
			category: task.category,
			passed: false,
			retries: 0,
			codeChars: 0,
			elapsedMs: 0,
			error: 'solution file not found',
		}
	}

	return lastRow
}

function normalizeSpec(value, taskGolden) {
	if (typeof value === 'string') {
		return { expect: 'value', golden: taskGolden, taxonomy: null }
	}
	return {
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
			codeChars: source.length,
		}
	} catch (cause) {
		return {
			ok: false,
			error: cause instanceof Error ? cause.message : String(cause),
			taxonomy: 'runtime',
			elapsedMs: Date.now() - startedAtMs,
			codeChars: source.length,
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

async function exists(filePath) {
	try {
		await access(filePath)
		return true
	} catch {
		return false
	}
}
