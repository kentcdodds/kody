import { readFileSync, writeFileSync } from 'node:fs'
import { isExecutedDirectly } from './node-runtime.ts'

// Wrangler augments `NodeJS.ProcessEnv` with the worker's vars and secrets as
// required strings. Worker code reads bindings from `env`, never `process.env`,
// but Node programs that include these types (tools, tests) would then require
// every worker secret on each `process.env`-typed value.
const processEnvBlockPattern =
	/^declare namespace NodeJS \{\n\tinterface ProcessEnv [^\n]*\n\}\n/m

export function stripWorkerProcessEnvTypes(source: string) {
	return source.replace(processEnvBlockPattern, '')
}

if (isExecutedDirectly(import.meta.url)) {
	const filePath = process.argv[2]
	if (!filePath) {
		throw new Error('Usage: strip-worker-process-env-types.ts <path>')
	}
	const source = readFileSync(filePath, 'utf8')
	const next = stripWorkerProcessEnvTypes(source)
	if (next !== source) writeFileSync(filePath, next)
}
