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

function omitNamedFlag(
	args: ReadonlyArray<string>,
	flag: '--config' | '--name',
) {
	const next: Array<string> = []
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]
		if (arg === flag) {
			index += 1
			continue
		}
		if (arg.startsWith(`${flag}=`)) continue
		next.push(arg)
	}
	return next
}

function readNamedFlag(
	args: ReadonlyArray<string>,
	flag: '--config' | '--name',
) {
	const inline = args.find((arg) => arg.startsWith(`${flag}=`))
	if (inline) {
		const value = inline.slice(`${flag}=`.length)
		return value || undefined
	}
	const flagIndex = args.findIndex((arg) => arg === flag)
	if (flagIndex >= 0) {
		const value = args[flagIndex + 1]
		return value || undefined
	}
	return undefined
}

export function omitConfigFlag(args: ReadonlyArray<string>) {
	return omitNamedFlag(args, '--config')
}

export function readConfigFlag(args: ReadonlyArray<string>) {
	return readNamedFlag(args, '--config')
}

export function omitNameFlag(args: ReadonlyArray<string>) {
	return omitNamedFlag(args, '--name')
}

export function readNameFlag(args: ReadonlyArray<string>) {
	return readNamedFlag(args, '--name')
}
