import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { classifyPythonFailure } from './classify-python-failure.mjs'

const harnessPath = fileURLToPath(
	new URL('./sandbox-harness.py', import.meta.url),
)

/**
 * Run one Python execute module on local CPython with the same kody.call
 * protocol the Worker Loader harness uses. This is the eval backend. Preview
 * runs go through the Worker Loader instead.
 */
export async function runCpythonExecute(input) {
	const startedAtMs = Date.now()
	const source = input.source
	const timeoutMs = input.timeoutMs ?? 15_000
	const child = spawn('python3', [harnessPath], {
		stdio: ['pipe', 'pipe', 'pipe'],
	})
	let stderr = ''
	child.stderr.setEncoding('utf8')
	child.stderr.on('data', (chunk) => {
		stderr += chunk
	})
	const lines = createInterface({ input: child.stdout })
	const pending = []
	lines.on('line', (line) => {
		pending.push(line)
	})

	const done = new Promise((resolve) => {
		let settled = false
		const timer = setTimeout(() => {
			finish({
				ok: false,
				error: 'Python execute timed out.',
				errorName: 'TimeoutError',
				logs: [],
				cpuMs: null,
			})
		}, timeoutMs)

		let exited = false
		child.on('exit', () => {
			exited = true
			setTimeout(() => {
				if (settled) return
				finish({
					ok: false,
					error:
						stderr.trim() || 'Python execute exited before returning a result.',
					errorName: 'RuntimeError',
					logs: [],
					cpuMs: null,
				})
			}, 30)
		})

		void drain()

		function finish(message) {
			if (settled) return
			settled = true
			clearTimeout(timer)
			lines.close()
			if (child.exitCode === null) child.kill('SIGKILL')
			resolve(message)
		}

		async function drain() {
			while (!settled) {
				if (pending.length === 0) {
					if (exited) {
						await new Promise((wait) => setTimeout(wait, 5))
						if (pending.length === 0) return
					}
					await new Promise((wait) => setTimeout(wait, 5))
					continue
				}
				const line = pending.shift()
				let message
				try {
					message = JSON.parse(line)
				} catch {
					continue
				}
				if (message.type === 'call') {
					try {
						const value = await input.call(message.name, message.args ?? {})
						child.stdin.write(`${JSON.stringify({ ok: true, value })}\n`)
					} catch (cause) {
						const error = cause instanceof Error ? cause.message : String(cause)
						child.stdin.write(`${JSON.stringify({ ok: false, error })}\n`)
					}
					continue
				}
				if (message.type === 'done') {
					finish(message)
					return
				}
			}
		}
	})

	child.stdin.write(
		`${JSON.stringify({ source, params: input.params ?? {} })}\n`,
	)
	const message = await done
	const elapsedMs = Math.max(0, Date.now() - startedAtMs)
	const error = message.ok ? null : message.error || 'Python execute failed.'
	return {
		ok: Boolean(message.ok),
		result: message.ok ? message.result : undefined,
		error,
		errorName: message.errorName ?? null,
		logs: Array.isArray(message.logs) ? message.logs : [],
		cpuMs: typeof message.cpuMs === 'number' ? message.cpuMs : null,
		elapsedMs,
		codeChars: source.length,
		taxonomy: error
			? classifyPythonFailure({
					errorName: message.errorName,
					message: error,
				})
			: null,
	}
}
