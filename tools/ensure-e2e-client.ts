import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { defaultClientEntryPath } from './dev-client-ready.ts'
import { isExecutedDirectly } from './node-runtime.ts'

export function ensureE2eClientBuilt(options?: {
	clientEntryPath?: string
	build?: () => void
}) {
	const clientEntryPath = options?.clientEntryPath ?? defaultClientEntryPath
	if (existsSync(clientEntryPath)) return
	const build =
		options?.build ??
		(() => {
			const result = spawnSync('npx', ['nx', 'run', 'worker:build-client'], {
				stdio: 'inherit',
			})
			if ((result.status ?? 1) !== 0) {
				throw new Error('Failed to build the e2e client bundle.')
			}
		})
	build()
}

if (isExecutedDirectly(import.meta.url)) {
	ensureE2eClientBuilt()
}
