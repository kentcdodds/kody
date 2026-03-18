import { basename } from 'node:path'
import { fail, runWrangler } from './ci/resource-utils.ts'
import { createPasswordHash } from '#shared/password-hash.ts'

type CliOptions = {
	email: string
	username: string
	password: string
	local: boolean
	remote: boolean
	env?: string
	config?: string
	persistTo?: string
}

const defaultTestEmail = 'me@kentcdodds.com'
const defaultTestPassword = 'iliketwix'

export function parseArgs(argv: Array<string>): CliOptions {
	const options: CliOptions = {
		email: defaultTestEmail,
		username: defaultTestEmail,
		password: defaultTestPassword,
		local: false,
		remote: false,
		env: undefined,
		config: undefined,
		persistTo: undefined,
	}
	let usernameProvided = false

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (!arg) continue

		switch (arg) {
			case '--email': {
				options.email = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--username': {
				usernameProvided = true
				options.username = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--password': {
				options.password = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--local': {
				options.local = true
				break
			}
			case '--remote': {
				options.remote = true
				break
			}
			case '--env': {
				options.env = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--config': {
				options.config = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--persist-to': {
				options.persistTo = argv[index + 1] ?? ''
				index += 1
				break
			}
			default: {
				if (arg.startsWith('-')) {
					fail(
						[
							`Unknown flag: ${arg}`,
							'Usage: bun tools/seed-test-data.ts [--local|--remote] [--env <name>] [--config <path>] [--persist-to <path>] [--email <email>] [--username <username>] [--password <password>]',
						].join('\n'),
					)
				}
			}
		}
	}

	if (options.local && options.remote) {
		fail('Choose only one target mode: --local or --remote.')
	}
	if (!options.local && !options.remote) {
		options.local = true
	}
	if (!options.email) {
		fail('Missing required --email <email> value.')
	}
	const effectiveEmail = options.email
	if (!usernameProvided) {
		options.username = effectiveEmail
	}
	if (!options.username) {
		fail('Missing required --username <username> value.')
	}
	if (!options.password) {
		fail('Missing required --password <password> value.')
	}
	if (options.remote && options.persistTo) {
		fail('--persist-to is only valid with --local.')
	}
	if (options.env !== undefined && options.env.length === 0) {
		fail('Missing value for --env <name>.')
	}
	if (options.config !== undefined && options.config.length === 0) {
		fail('Missing value for --config <path>.')
	}
	if (options.persistTo !== undefined && options.persistTo.length === 0) {
		fail('Missing value for --persist-to <path>.')
	}
	options.env = resolveWranglerEnv(options)

	return options
}

export function resolveWranglerEnv({
	env,
	config,
}: {
	env?: string
	config?: string
}) {
	if (env && env.length > 0) return env

	const configBaseName = basename(config ?? '').toLowerCase()
	if (configBaseName.includes('preview')) return 'preview'
	if (configBaseName.includes('test')) return 'test'
	if (configBaseName.includes('production')) return 'production'

	return process.env.CLOUDFLARE_ENV ?? 'production'
}

function quoteSql(value: string) {
	return `'${value.replace(/'/g, "''")}'`
}

function buildSeedSql({
	email,
	username,
	passwordHash,
}: {
	email: string
	username: string
	passwordHash: string
}) {
	return `
INSERT INTO users (username, email, password_hash)
VALUES (${quoteSql(username)}, ${quoteSql(email)}, ${quoteSql(passwordHash)})
ON CONFLICT(email) DO UPDATE SET
  username = excluded.username,
  password_hash = excluded.password_hash,
  updated_at = CURRENT_TIMESTAMP;
`.trim()
}

function executeSeedSql(sql: string, options: CliOptions) {
	const args = ['d1', 'execute', 'APP_DB', '--command', sql]
	if (options.local) {
		args.push('--local')
		if (options.persistTo) {
			args.push('--persist-to', options.persistTo)
		}
	}
	if (options.remote) {
		args.push('--remote')
	}
	if (options.env) {
		args.push('--env', options.env)
	}
	if (options.config) {
		args.push('--config', options.config)
	}

	const result = runWrangler(args)
	if (result.status !== 0) {
		fail('Failed to write seed user directly to D1.')
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	const passwordHash = await createPasswordHash(options.password)
	const sql = buildSeedSql({
		email: options.email,
		username: options.username,
		passwordHash,
	})
	executeSeedSql(sql, options)

	console.log(
		`Seeded test account in D1 (${options.local ? 'local' : 'remote'}): ${options.email}`,
	)
}

if (import.meta.main) {
	await main()
}
