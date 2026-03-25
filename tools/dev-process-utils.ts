import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { platform } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
const supportsProcessGroups = platform() !== 'win32'

export function spawnInOwnProcessGroup(
	command: string,
	args: Array<string>,
	options: SpawnOptions,
) {
	return spawn(command, args, {
		...options,
		detached: supportsProcessGroups,
	})
}

export async function stopChildProcessTree(
	child: ChildProcess,
	options: {
		sigintTimeoutMs?: number
		sigtermTimeoutMs?: number
		sigkillTimeoutMs?: number
	} = {},
) {
	if (child.exitCode !== null || child.pid == null) return

	const sigintTimeoutMs = options.sigintTimeoutMs ?? 5000
	const sigtermTimeoutMs = options.sigtermTimeoutMs ?? 2000
	const sigkillTimeoutMs = options.sigkillTimeoutMs ?? 1000

	signalChildProcessTree(child, 'SIGINT')
	if (await waitForExit(child, sigintTimeoutMs)) return

	signalChildProcessTree(child, 'SIGTERM')
	if (await waitForExit(child, sigtermTimeoutMs)) return

	signalChildProcessTree(child, 'SIGKILL')
	await waitForExit(child, sigkillTimeoutMs)
}

export function signalChildProcessTree(
	child: ChildProcess,
	signal: NodeJS.Signals,
) {
	if (child.pid == null) return

	try {
		if (supportsProcessGroups) {
			process.kill(-child.pid, signal)
			return
		}
		child.kill(signal)
	} catch (error) {
		if (!isNoSuchProcessError(error)) {
			throw error
		}
	}
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
	return Promise.race([
		new Promise<boolean>((resolve) => {
			if (child.exitCode !== null) {
				resolve(true)
				return
			}
			child.once('exit', () => resolve(true))
		}),
		delay(timeoutMs).then(() => false),
	])
}

function isNoSuchProcessError(error: unknown) {
	return error instanceof Error && 'code' in error && error.code === 'ESRCH'
}
