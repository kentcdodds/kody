import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { fail, runWrangler } from './ci/resource-utils.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { isExecutedDirectly } from './node-runtime.ts'
import {
	getDefaultWranglerConfigPath,
	resolveWranglerConfigPath,
} from './wrangler-env-config.ts'

type CliOptions = {
	email: string
	username: string
	password: string
	local: boolean
	remote: boolean
	admin: boolean
	env?: string
	config?: string
	persistTo?: string
}

const defaultTestEmail = 'kody@example.com'
const defaultTestUsername = 'kody'
const defaultTestPassword = 'ilikecode'
// Companion non-admin fixture so RBAC flows can be tested from both sides.
const regularTestEmail = 'jane@example.com'
const regularTestUsername = 'jane'

export function parseArgs(argv: Array<string>): CliOptions {
	const options: CliOptions = {
		email: defaultTestEmail,
		username: defaultTestUsername,
		password: defaultTestPassword,
		local: false,
		remote: false,
		admin: false,
		env: undefined,
		config: undefined,
		persistTo: undefined,
	}
	let usernameProvided = false
	let adminProvided = false

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
			case '--admin': {
				adminProvided = true
				options.admin = true
				break
			}
			case '--no-admin': {
				adminProvided = true
				options.admin = false
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
							'Usage: node tools/seed-test-data.ts [--local|--remote] [--admin|--no-admin] [--env <name>] [--config <path>] [--persist-to <path>] [--email <email>] [--username <username>] [--password <password>]',
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
		options.username =
			effectiveEmail === defaultTestEmail
				? defaultTestUsername
				: usernameFromEmail(effectiveEmail)
	}
	// The default fixture account is an admin so RBAC features are testable
	// out of the box; custom accounts stay non-admin unless requested.
	if (!adminProvided) {
		options.admin = effectiveEmail === defaultTestEmail
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

function usernameFromEmail(email: string) {
	const localPart = email.split('@')[0] ?? 'user'
	const normalized = localPart
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
	const truncated = normalized
		.slice(0, 32)
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
	return truncated.length >= 3 ? truncated : `user-${truncated || 'test'}`
}

type SeedAccount = {
	email: string
	username: string
	passwordHash: string
	admin: boolean
}

function buildAccountSeedSql({
	email,
	username,
	passwordHash,
	admin,
}: SeedAccount) {
	const userRoleSql = `
INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = ${quoteSql(email)} AND r.name = 'user';`
	const adminRoleSql = admin
		? `
INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = ${quoteSql(email)} AND r.name = 'admin';`
		: ''

	return `
INSERT INTO users (username, email, password_hash)
VALUES (${quoteSql(username)}, ${quoteSql(email)}, ${quoteSql(passwordHash)})
ON CONFLICT(email) DO UPDATE SET
  username = excluded.username,
  password_hash = excluded.password_hash,
  updated_at = CURRENT_TIMESTAMP;
${userRoleSql}${adminRoleSql}`.trim()
}

export function buildSeedSql(accounts: Array<SeedAccount>) {
	return accounts.map(buildAccountSeedSql).join('\n')
}

/**
 * The companion fixture uses a fixed, public password, so it is seeded for
 * local development only — never into remote (deployed) environments.
 */
export function shouldSeedCompanionAccount(
	options: Pick<CliOptions, 'local' | 'email'>,
) {
	return options.local && options.email !== regularTestEmail
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
	// Wrangler cannot resolve APP_DB without the worker config; fall back to
	// the repo default (same behavior as wrangler-env.ts) when none is given.
	const configPath = options.config ?? getDefaultWranglerConfigPath()
	if (existsSync(resolveWranglerConfigPath(configPath, process.cwd()))) {
		args.push('--config', configPath)
	}

	const result = runWrangler(args)
	if (result.status !== 0) {
		fail('Failed to write seed user directly to D1.')
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	const passwordHash = await createPasswordHash(options.password)
	const accounts: Array<SeedAccount> = [
		{
			email: options.email,
			username: options.username,
			passwordHash,
			admin: options.admin,
		},
	]
	if (shouldSeedCompanionAccount(options)) {
		accounts.push({
			email: regularTestEmail,
			username: regularTestUsername,
			passwordHash: await createPasswordHash(defaultTestPassword),
			admin: false,
		})
	}
	const sql = buildSeedSql(accounts)
	executeSeedSql(sql, options)

	const primaryLabel = options.admin ? 'admin' : 'regular'
	const companionSuffix =
		accounts.length > 1 ? ` + ${accounts.length - 1} regular` : ''
	console.log(
		`Seeded ${accounts.length} test account${accounts.length > 1 ? 's' : ''} in D1 (${options.local ? 'local' : 'remote'}): 1 ${primaryLabel}${companionSuffix}`,
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
