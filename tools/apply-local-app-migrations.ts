import { spawnSync } from 'node:child_process'

function localPersistenceArguments(arguments_: ReadonlyArray<string>) {
	const allowed: Array<string> = []
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index]!
		if (argument.startsWith('--persist-to=')) {
			allowed.push(argument)
			continue
		}
		if (argument === '--persist-to' && arguments_[index + 1]) {
			allowed.push(argument, arguments_[index + 1]!)
			index += 1
			continue
		}
		throw new Error(
			`Unsupported local migration argument: ${argument}. Only --persist-to is allowed.`,
		)
	}
	return allowed
}

const passthroughArguments = localPersistenceArguments(process.argv.slice(2))
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

// A nonempty pre-0135 local database reaches the approval guard without a
// control-plane receipt. Insert an explicit test fixture only for that expected
// guard failure and retry; fresh empty databases use 0135's bootstrap path.
const initialFailure = output(initialApply)
if (
	!initialFailure.includes('0135-drop-legacy-email-graph.sql') ||
	!initialFailure.includes('CHECK constraint failed: value = 1')
) {
	fail(
		'Local APP_DB migrations failed outside the approval gate.',
		initialApply,
	)
}
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
		initialApply,
		retryApply,
	)
}

process.stdout.write(approval.stdout)
process.stderr.write(approval.stderr)
process.stdout.write(retryApply.stdout)
process.stderr.write(retryApply.stderr)
