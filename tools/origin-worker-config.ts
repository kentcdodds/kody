/**
 * Origin Wrangler configs live under `packages/worker/` and are named
 * `wrangler.jsonc` or `wrangler-*.generated.json`. Sibling fleet configs
 * (platform, runtime, jobs, highlight, mocks) use a different directory.
 */
export function isOriginWorkerConfigPath(configPath: string | undefined) {
	if (configPath === undefined) return true
	const normalized = configPath.replaceAll('\\', '/')
	const fileName = normalized.split('/').pop() ?? normalized
	return (
		normalized.includes('packages/worker/') &&
		(fileName === 'wrangler.jsonc' ||
			/^wrangler-[a-z0-9.-]+\.generated\.json$/.test(fileName))
	)
}

export function omitConfigFlag(args: ReadonlyArray<string>) {
	const next: Array<string> = []
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]
		if (arg === '--config') {
			index += 1
			continue
		}
		if (arg.startsWith('--config=')) continue
		next.push(arg)
	}
	return next
}

export function readConfigFlag(args: ReadonlyArray<string>) {
	const inline = args.find((arg) => arg.startsWith('--config='))
	if (inline) {
		const value = inline.slice('--config='.length)
		return value || undefined
	}
	const flagIndex = args.findIndex((arg) => arg === '--config')
	if (flagIndex >= 0) {
		const value = args[flagIndex + 1]
		return value || undefined
	}
	return undefined
}
