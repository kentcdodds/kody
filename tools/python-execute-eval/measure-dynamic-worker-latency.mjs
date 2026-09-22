import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const port = Number(process.env.PYTHON_EXECUTE_LATENCY_PORT ?? '8794')
const rounds = process.env.PYTHON_EXECUTE_LATENCY_ROUNDS ?? '5'
const configPath = fileURLToPath(
	new URL('./dynamic-worker-latency/wrangler.jsonc', import.meta.url),
)
const outPath =
	'/opt/cursor/artifacts/python-execute-dynamic-worker-latency.json'

const child = spawn(
	'npx',
	[
		'wrangler',
		'dev',
		'--config',
		configPath,
		'--port',
		String(port),
		'--ip',
		'127.0.0.1',
		'--local',
	],
	{
		stdio: ['ignore', 'pipe', 'pipe'],
		cwd: fileURLToPath(new URL('../../', import.meta.url)),
		detached: true,
	},
)

let logs = ''
function collect(chunk) {
	logs += chunk
	if (logs.length > 80_000) logs = logs.slice(-40_000)
}
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', collect)
child.stderr.on('data', collect)

const base = `http://127.0.0.1:${port}`

try {
	await waitForHealth(base)
	const response = await fetch(`${base}/?rounds=${rounds}`, {
		signal: AbortSignal.timeout(180_000),
	})
	const body = await response.text()
	if (!response.ok) {
		throw new Error(
			`latency probe HTTP ${response.status}: ${body.slice(0, 2000)}`,
		)
	}
	const report = JSON.parse(body)
	await mkdir('/opt/cursor/artifacts', { recursive: true })
	await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`)
	process.stdout.write(`${JSON.stringify(summarize(report), null, 2)}\n`)
	const failed = report.scenarios.some((scenario) =>
		scenario.samples.some((sample) => !sample.coldOk || !sample.warmOk),
	)
	if (failed) {
		process.stderr.write(`${body}\n`)
		process.exitCode = 1
	}
} finally {
	await stopChild(child)
}

function summarize(report) {
	return {
		ranAt: report.ranAt,
		rounds: report.rounds,
		scenarios: report.scenarios.map((scenario) => ({
			name: scenario.name,
			language: scenario.language,
			processColdMs: scenario.processColdMs,
			medianNewIdColdMs: scenario.medianNewIdColdMs,
			medianWarmMs: scenario.medianWarmMs,
			processColdOk: scenario.processColdOk,
			coldOk: scenario.samples.map((sample) => sample.coldOk),
			warmOk: scenario.samples.map((sample) => sample.warmOk),
		})),
	}
}

async function waitForHealth(origin) {
	const deadline = Date.now() + 90_000
	let lastError = 'not started'
	while (Date.now() < deadline) {
		if (child.exitCode != null) {
			throw new Error(`wrangler exited ${child.exitCode} before ready\n${logs}`)
		}
		try {
			const response = await fetch(`${origin}/health`, {
				signal: AbortSignal.timeout(2_000),
			})
			if (response.ok) return
			lastError = `HTTP ${response.status}`
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error)
		}
		await delay(500)
	}
	throw new Error(`latency worker did not become ready: ${lastError}\n${logs}`)
}

function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}

async function stopChild(childProcess) {
	if (childProcess.exitCode != null) return
	signalTree(childProcess, 'SIGTERM')
	const exited = new Promise((resolve) => {
		childProcess.once('exit', resolve)
	})
	const timedOut = delay(8_000).then(() => 'timeout')
	const result = await Promise.race([exited, timedOut])
	if (result === 'timeout') signalTree(childProcess, 'SIGKILL')
}

function signalTree(childProcess, signal) {
	if (childProcess.pid == null) return
	try {
		process.kill(-childProcess.pid, signal)
	} catch {
		try {
			childProcess.kill(signal)
		} catch {
			// The dev process already exited.
		}
	}
}
