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

// A fresh local database reaches the non-destructive 0134 approval schema, then
// 0135 stops because no control-plane receipt exists locally. Insert an explicit
// test fixture and retry; every other destructive guard still applies.
const approval = runWrangler([
	'--env-file=packages/worker/.env',
	'./wrangler-env.ts',
	'd1',
	'execute',
	'APP_DB',
	'--local',
	'--file',
	'tools/local-mailbox-pre-drop-approval-fixture.sql',
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
