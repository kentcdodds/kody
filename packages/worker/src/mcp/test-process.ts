import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { type Readable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { setTimeout as delay } from 'node:timers/promises'

export const bunBin = process.env.BUN_BINARY?.trim() || 'bun'

export type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable> & {
	exited: Promise<number | null>
}

export function spawnProcess(input: {
	cmd: [string, ...Array<string>]
	cwd: string
	env?: NodeJS.ProcessEnv
}): SpawnedProcess {
	const proc = spawn(input.cmd[0], input.cmd.slice(1), {
		cwd: input.cwd,
		env: input.env,
		stdio: ['ignore', 'pipe', 'pipe'],
	})

	const exited = new Promise<number | null>((resolve, reject) => {
		proc.once('error', reject)
		proc.once('exit', (code) => resolve(code))
	})

	return Object.assign(proc, { exited })
}

export function captureOutput(stream: NodeJS.ReadableStream | null) {
	let output = ''
	if (!stream) {
		return () => output
	}

	stream.on('data', (chunk) => {
		output += chunk.toString()
	})
	stream.on('error', () => {
		// Ignore stream errors while capturing output.
	})

	return () => output
}

export async function readOutput(stream: NodeJS.ReadableStream | null) {
	if (!stream) {
		return ''
	}

	return text(stream)
}

export async function stopProcess(proc: SpawnedProcess) {
	let exited = false
	void proc.exited
		.then(() => {
			exited = true
		})
		.catch(() => {
			exited = true
		})

	proc.kill('SIGINT')
	await Promise.race([proc.exited.catch(() => null), delay(5_000)])

	if (!exited) {
		proc.kill('SIGKILL')
		await proc.exited.catch(() => null)
	}
}
