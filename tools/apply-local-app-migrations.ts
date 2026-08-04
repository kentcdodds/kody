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
// Pre-squash local databases carry full migration history in d1_migrations;
// the guard rewrites that bookkeeping to the squashed baseline (and refuses
// anything unexpected) before the regular apply runs.
const bookkeepingArguments = [
	'tools/ci/reset-migration-bookkeeping.ts',
	'--local',
	...passthroughArguments,
]
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

const bookkeeping = runWrangler(bookkeepingArguments)
process.stdout.write(bookkeeping.stdout)
process.stderr.write(bookkeeping.stderr)
if (bookkeeping.status !== 0) {
	process.exit(bookkeeping.status ?? 1)
}

const apply = runWrangler(migrationArguments)
process.stdout.write(apply.stdout)
process.stderr.write(apply.stderr)
if (apply.status !== 0) {
	process.exit(apply.status ?? 1)
}
