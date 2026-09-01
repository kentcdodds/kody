import { statSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

export const defaultClientEntryPath = 'packages/worker/public/client-entry.js'
export const defaultClientReadyTimeoutMs = 30_000
export const defaultClientReadyPollMs = 200

export function clientEntryStat(filePath: string) {
	try {
		return { mtimeMs: statSync(filePath).mtimeMs }
	} catch {
		return null
	}
}

export async function waitForClientEntryReady(input: {
	path?: string
	sinceMs: number
	timeoutMs: number
	pollMs?: number
	stat?: (path: string) => { mtimeMs: number } | null
	now?: () => number
	sleep?: (ms: number) => Promise<void>
	isCancelled?: () => boolean
}) {
	const filePath = input.path ?? defaultClientEntryPath
	const pollMs = input.pollMs ?? defaultClientReadyPollMs
	const now = input.now ?? Date.now
	const sleep = input.sleep ?? delay
	const stat = input.stat ?? clientEntryStat
	const deadline = now() + input.timeoutMs
	while (now() < deadline) {
		if (input.isCancelled?.()) return false
		const info = stat(filePath)
		if (info && info.mtimeMs >= input.sinceMs) return true
		await sleep(pollMs)
	}
	const info = stat(filePath)
	return Boolean(info && info.mtimeMs >= input.sinceMs)
}
