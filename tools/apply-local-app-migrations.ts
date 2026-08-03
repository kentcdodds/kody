import { spawnSync } from 'node:child_process'

const passthroughArguments = process.argv.slice(2)
const migrationArguments = [
	'--env-file=packages/worker/.env',
	'./wrangler-env.ts',
	'd1',
	'migrations',
	'apply',
	'APP_DB',
	'--local',
	...passthroughArguments,
]

function runWrangler(arguments_: ReadonlyArray<string>) {
	return spawnSync(process.execPath, arguments_, {
		cwd: process.cwd(),
		encoding: 'utf8',
		env: process.env,
		maxBuffer: 16 * 1024 * 1024,
	})
}

function output(result: ReturnType<typeof runWrangler>) {
	return [result.stdout, result.stderr].filter(Boolean).join('\n')
}

function fail(
	message: string,
	...results: Array<ReturnType<typeof runWrangler>>
) {
	console.error(
		[message, ...results.map(output).filter(Boolean)]
			.filter(Boolean)
			.join('\n\n'),
	)
	process.exit(1)
}

const initialApply = runWrangler(migrationArguments)
if (initialApply.status === 0) {
	process.stdout.write(initialApply.stdout)
	process.stderr.write(initialApply.stderr)
	process.exit(0)
}

// A fresh local database reaches 0134 after Wrangler commits 0001-0133, then
// stops because production's operator-created approval table is intentionally
// absent. Insert local evidence and retry; every other 0134 guard still applies.
const approval = runWrangler([
	'--env-file=packages/worker/.env',
	'./wrangler-env.ts',
	'd1',
	'execute',
	'APP_DB',
	'--local',
	'--file',
	'tools/local-email-graph-drop-approval.sql',
	...passthroughArguments,
])
if (approval.status !== 0) {
	fail(
		'Local APP_DB migrations failed before approval could be prepared.',
		initialApply,
		approval,
	)
}

const retryApply = runWrangler(migrationArguments)
if (retryApply.status !== 0) {
	fail(
		'Local APP_DB migrations still failed after approval preparation.',
		retryApply,
	)
}

process.stdout.write(approval.stdout)
process.stderr.write(approval.stderr)
process.stdout.write(retryApply.stdout)
process.stderr.write(retryApply.stderr)
