import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isExecutedDirectly } from '../node-runtime.ts'
import { fail } from '../ci/resource-utils.ts'
import {
	assertRehearsalWorkerName,
	formatD1SnapshotMarkdown,
	parseD1RehearsalSnapshot,
	restoreD1RehearsalSnapshot,
	takeD1RehearsalSnapshot,
	type CloudflareClient,
} from './d1-rehearsal.ts'
import {
	diffSnapshots,
	takeJsonSnapshot,
	type SnapshotUser,
} from './json-snapshot.ts'
import { openRehearsalSession } from './kody-session.ts'
import {
	deriveRehearsalPassword,
	rehearsalUsers,
	renamedDaveUsername,
	resolveRehearsalOrigins,
	type RehearsalOrigins,
} from './rehearsal-env.ts'
import { importRecipientPublicKey, sealJson } from './seal.ts'
import { mintCliToken, seedRehearsal, type TokenLifetime } from './seed.ts'

export const rehearsalUsage = [
	'Usage: node tools/preview-rehearsal/run.ts <command> [flags]',
	'',
	'CI commands (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID; seed/json-snapshot/credentials also REHEARSAL_PASSWORD_KEY):',
	'  d1-snapshot  --worker <kody-branch-*> --out <d1-snapshot.json> [--summary <file.md>]',
	'  d1-restore   --worker <kody-branch-*> --snapshot <d1-snapshot.json> --confirm <kody-branch-*>',
	'  seed         --worker <kody-branch-*> --out-dir <dir> --recipient-public-key <base64 SPKI>',
	'  credentials  --worker <kody-branch-*> --out <sealed.json> --recipient-public-key <base64 SPKI>',
	'               (--lifetime short|long | --idle-ttl-seconds <n> --max-lifetime-seconds <n>)',
	'  json-snapshot --worker <kody-branch-*> --out <json-snapshot.json>',
	'  origins      --worker <kody-branch-*>   (prints the app, API, and mock origins as JSON)',
	'',
	'Operator commands (no Cloudflare credentials):',
	'  json-snapshot --credentials <opened-credentials.json> --out <json-snapshot.json>',
	'  diff --before <snapshot.json> --after <snapshot.json>',
].join('\n')

export function readFlags(argv: ReadonlyArray<string>) {
	const flags = new Map<string, string>()
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? ''
		if (!arg.startsWith('--')) {
			throw new Error(`Unexpected argument "${arg}".\n${rehearsalUsage}`)
		}
		const value = argv[index + 1]
		if (value === undefined || value.startsWith('--')) {
			throw new Error(`Missing value for ${arg}.\n${rehearsalUsage}`)
		}
		flags.set(arg.slice(2), value)
		index += 1
	}
	return flags
}

function requireFlag(flags: Map<string, string>, name: string) {
	const value = flags.get(name)?.trim()
	if (!value) fail(`Missing --${name}.\n${rehearsalUsage}`)
	return value
}

function requireEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) fail(`Missing ${name}.`)
	return value
}

export function readTokenLifetime(flags: Map<string, string>): TokenLifetime {
	const alias = flags.get('lifetime')
	const idle = flags.get('idle-ttl-seconds')
	const max = flags.get('max-lifetime-seconds')
	if (alias && (idle || max)) {
		throw new Error('Pass --lifetime or both TTL flags, not both.')
	}
	if (alias === 'short' || alias === 'long') return { lifetime: alias }
	if (alias) {
		throw new Error(`--lifetime must be short or long, not "${alias}".`)
	}
	const isPositiveInteger = (value: string | undefined) =>
		value !== undefined && /^[1-9]\d*$/.test(value.trim())
	if (!isPositiveInteger(idle) || !isPositiveInteger(max)) {
		throw new Error(
			'An explicit token lifetime is required: --lifetime short|long, or --idle-ttl-seconds <n> --max-lifetime-seconds <n>.',
		)
	}
	return {
		idle_ttl_seconds: Number(idle),
		max_lifetime_seconds: Number(max),
	}
}

function cloudflareClient(): CloudflareClient {
	return {
		accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: requireEnv('CLOUDFLARE_API_TOKEN'),
	}
}

/** Mask values in GitHub Actions logs before anything could echo them. */
function maskInActions(value: string) {
	if (process.env.GITHUB_ACTIONS === 'true' && value) {
		console.log(`::add-mask::${value}`)
	}
}

async function derivedUsers(workerName: string): Promise<Array<SnapshotUser>> {
	const key = requireEnv('REHEARSAL_PASSWORD_KEY')
	const users: Array<SnapshotUser> = []
	for (const user of rehearsalUsers) {
		const password = await deriveRehearsalPassword({
			key,
			workerName,
			role: user.role,
		})
		maskInActions(password)
		users.push({
			role: user.role,
			email: user.email,
			username: user.role === 'dave' ? renamedDaveUsername : user.username,
			password,
		})
	}
	return users
}

async function writeJson(path: string, value: unknown, mode?: number) {
	await writeFile(
		path,
		`${JSON.stringify(value, null, 2)}\n`,
		mode ? { mode } : {},
	)
}

async function main(argv: ReadonlyArray<string>) {
	const [command, ...rest] = argv
	const flags = readFlags(rest)
	const log = (line: string) => console.error(line)
	switch (command) {
		case 'd1-snapshot': {
			const workerName = assertRehearsalWorkerName(requireFlag(flags, 'worker'))
			const snapshot = await takeD1RehearsalSnapshot(
				cloudflareClient(),
				workerName,
			)
			await writeJson(requireFlag(flags, 'out'), snapshot)
			const summary = flags.get('summary')
			if (summary) await writeFile(summary, formatD1SnapshotMarkdown(snapshot))
			log(`D1 snapshot written for ${workerName}.`)
			return
		}
		case 'd1-restore': {
			const workerName = assertRehearsalWorkerName(requireFlag(flags, 'worker'))
			if (requireFlag(flags, 'confirm') !== workerName) {
				fail(`--confirm must equal --worker (${workerName}) to restore.`)
			}
			const snapshot = parseD1RehearsalSnapshot(
				await readFile(requireFlag(flags, 'snapshot'), 'utf8'),
			)
			const results = await restoreD1RehearsalSnapshot(
				cloudflareClient(),
				workerName,
				snapshot,
			)
			console.log(
				JSON.stringify(
					{ workerName, takenAt: snapshot.takenAt, results },
					null,
					2,
				),
			)
			return
		}
		case 'seed': {
			const workerName = assertRehearsalWorkerName(requireFlag(flags, 'worker'))
			const outDir = requireFlag(flags, 'out-dir')
			const publicKey = await importRecipientPublicKey(
				requireFlag(flags, 'recipient-public-key'),
			)
			await derivedUsers(workerName)
			const client = cloudflareClient()
			const origins = await resolveRehearsalOrigins(client, workerName)
			const { manifest, credentials } = await seedRehearsal({
				client,
				workerName,
				origins,
				passwordKey: requireEnv('REHEARSAL_PASSWORD_KEY'),
				log,
			})
			for (const user of credentials.users) {
				maskInActions(user.cliToken)
				maskInActions(user.everyScopeToken)
			}
			await mkdir(outDir, { recursive: true })
			await writeJson(join(outDir, 'seed-manifest.json'), manifest)
			await writeJson(
				join(outDir, 'credentials.sealed.json'),
				await sealJson(credentials, publicKey),
			)
			log(`Seeded ${workerName}; manifest and sealed credentials in ${outDir}.`)
			return
		}
		case 'credentials': {
			const workerName = assertRehearsalWorkerName(requireFlag(flags, 'worker'))
			const lifetime = readTokenLifetime(flags)
			const publicKey = await importRecipientPublicKey(
				requireFlag(flags, 'recipient-public-key'),
			)
			const origins = await resolveRehearsalOrigins(
				cloudflareClient(),
				workerName,
			)
			const users = []
			for (const user of await derivedUsers(workerName)) {
				const session = await openRehearsalSession(origins.app, user)
				try {
					const token = await mintCliToken(
						session,
						origins,
						`rehearsal-${user.role}-${new Date().toISOString().slice(0, 10)}`,
						lifetime,
					)
					maskInActions(token)
					users.push({ ...user, token })
				} finally {
					await session.close()
				}
			}
			await writeJson(
				requireFlag(flags, 'out'),
				await sealJson(
					{ version: 1, workerName, origins, lifetime, users },
					publicKey,
				),
			)
			log(
				`Minted ${users.length} CLI tokens (${JSON.stringify(lifetime)}), sealed.`,
			)
			return
		}
		case 'json-snapshot': {
			const out = requireFlag(flags, 'out')
			let origins: RehearsalOrigins
			let users: Array<SnapshotUser>
			const credentialsPath = flags.get('credentials')
			if (credentialsPath) {
				const opened = JSON.parse(await readFile(credentialsPath, 'utf8')) as {
					origins: RehearsalOrigins
					users: Array<SnapshotUser>
				}
				origins = opened.origins
				users = opened.users
			} else {
				const workerName = assertRehearsalWorkerName(
					requireFlag(flags, 'worker'),
				)
				origins = await resolveRehearsalOrigins(cloudflareClient(), workerName)
				users = await derivedUsers(workerName)
			}
			const snapshot = await takeJsonSnapshot({ origins, users, log })
			await writeJson(out, snapshot)
			log(`JSON snapshot written to ${out}.`)
			if (snapshot.failures.length > 0) {
				fail(
					`${snapshot.failures.length} snapshot check(s) failed:\n${snapshot.failures
						.map((failure) => `  ${failure.check}: ${failure.error}`)
						.join('\n')}`,
				)
			}
			return
		}
		case 'origins': {
			const workerName = assertRehearsalWorkerName(requireFlag(flags, 'worker'))
			console.log(
				JSON.stringify(
					await resolveRehearsalOrigins(cloudflareClient(), workerName),
				),
			)
			return
		}
		case 'diff': {
			const before = JSON.parse(
				await readFile(requireFlag(flags, 'before'), 'utf8'),
			)
			const after = JSON.parse(
				await readFile(requireFlag(flags, 'after'), 'utf8'),
			)
			const differences = diffSnapshots(before, after)
			console.log(JSON.stringify(differences, null, 2))
			if (differences.length > 0) process.exitCode = 1
			return
		}
		default:
			fail(rehearsalUsage)
	}
}

if (isExecutedDirectly(import.meta.url)) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		fail(
			error instanceof Error ? (error.stack ?? error.message) : String(error),
		)
	})
}
