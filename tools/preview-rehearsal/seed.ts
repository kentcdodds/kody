import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { apiTokenScopes } from '#worker/api-tokens/scopes.ts'
import { buildSecretHostApprovalUrl } from '#mcp/secrets/host-approval.ts'
import { buildSeedUserSql } from '../seed-sql.ts'
import {
	queryD1,
	resolveRehearsalDatabases,
	type CloudflareClient,
	type RehearsalDatabase,
} from './d1-rehearsal.ts'
import {
	describeFailure,
	openRehearsalSession,
	postJson,
	requestOk,
	type RehearsalSession,
} from './kody-session.ts'
import {
	deriveRehearsalPassword,
	rehearsalPlatformAccount,
	rehearsalUser,
	rehearsalUsers,
	renamedDaveUsername,
	sharingOptInRoles,
	type RehearsalOrigins,
	type RehearsalUser,
} from './rehearsal-env.ts'
import {
	integrationName,
	packageSecretName,
	personalPackageFiles,
	personalPackageLeaf,
	platformPackageFiles,
	platformPackages,
	rehearsalMemories,
	userSecretName,
} from './rehearsal-packages.ts'

const capabilityModule = [
	"import { kody } from 'kody:runtime'",
	'export default async function main(params) {',
	'\treturn kody[params.capability](params.input ?? {})',
	'}',
].join('\n')

export async function callCapability<T = Record<string, unknown>>(
	session: RehearsalSession,
	capability: string,
	input: Record<string, unknown> = {},
) {
	try {
		return (await session.execute(capabilityModule, { capability, input })) as T
	} catch (error) {
		throw new Error(
			`${capability} as ${session.email} failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

export function packageExportModule(specifier: string) {
	return [
		`import run from ${JSON.stringify(specifier)}`,
		'export default async function main(params) {',
		'\treturn run(params)',
		'}',
	].join('\n')
}

export const userSecretProofModule = (echoUrl: string) =>
	[
		'export default async function main() {',
		`\tconst response = await fetch(${JSON.stringify(echoUrl)}, {`,
		`\t\theaders: { 'x-rehearsal-secret': '{{secret:${userSecretName}}}' },`,
		'\t})',
		'\tconst body = await response.json()',
		"\treturn { status: response.status, sha256: body?.sha256?.['x-rehearsal-secret'] ?? null }",
		'}',
	].join('\n')

export const integrationProofModule = (echoUrl: string) =>
	[
		"import { createAuthenticatedFetch } from 'kody:runtime'",
		'export default async function main() {',
		`\tconst authedFetch = await createAuthenticatedFetch(${JSON.stringify(integrationName)})`,
		`\tconst response = await authedFetch(${JSON.stringify(echoUrl)})`,
		'\tconst body = await response.json()',
		'\treturn { status: response.status, bearerSent: Boolean(body?.sha256?.authorization) }',
		'}',
	].join('\n')

function randomSecretValue() {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		'base64url',
	)
}

function readRecord(value: unknown, label: string) {
	if (!value || typeof value !== 'object') {
		throw new Error(`${label} returned ${JSON.stringify(value)}.`)
	}
	return value as Record<string, unknown>
}

function readStringAt(value: unknown, path: Array<string>, label: string) {
	let current: unknown = value
	for (const key of path) {
		current = readRecord(current, label)[key]
	}
	if (typeof current !== 'string' || !current) {
		throw new Error(
			`${label} is missing ${path.join('.')}: ${JSON.stringify(value)}`,
		)
	}
	return current
}

export type SeedLog = (line: string) => void

export type SeededPerson = {
	role: RehearsalUser['role']
	email: string
	username: string
	stableUserId: string
	origin: RehearsalUser['origin']
	packageId: string | null
	packageName: string | null
	webhookHandle: string | null
	jobIds: Array<string>
	userSecretSha256: string | null
	packageSecretSha256: string | null
}

export type SeedManifest = {
	version: 1
	workerName: string
	seededAt: string
	origins: RehearsalOrigins
	people: Array<SeededPerson>
	platform: {
		email: string
		username: string
		scopeGrantee: string
		packages: Array<{ leaf: string; visibility: string; packageId: string }>
		listingId: string
		forkedBy: string
		forkPackageId: string
	}
	sharing: {
		acceptedGrantId: string
		pendingGrantId: string
	}
	renamed: { from: string; to: string }
	autoRefill: { role: RehearsalUser['role'] }
}

export type SeedCredentials = {
	version: 1
	workerName: string
	origins: RehearsalOrigins
	users: Array<{
		role: RehearsalUser['role']
		email: string
		username: string
		password: string
		cliToken: string
		everyScopeToken: string
	}>
}

type SeedInput = {
	client: CloudflareClient
	workerName: string
	origins: RehearsalOrigins
	passwordKey: string
	log?: SeedLog
	now?: () => Date
}

async function sessionFor(
	input: SeedInput,
	user: RehearsalUser,
	username = user.username,
) {
	const password = await deriveRehearsalPassword({
		key: input.passwordKey,
		workerName: input.workerName,
		role: user.role,
	})
	return openRehearsalSession(input.origins.app, {
		email: user.email,
		username,
		password,
	})
}

async function approveSecretHost(
	session: RehearsalSession,
	input: {
		origin: string
		name: string
		host: string
		packageId: string | null
	},
) {
	const approvalUrl = new URL(
		buildSecretHostApprovalUrl({
			baseUrl: input.origin,
			name: input.name,
			scope: input.packageId ? 'package' : 'user',
			requestedHost: input.host,
			storageContext: input.packageId
				? {
						sessionId: null,
						appId: null,
						packageId: input.packageId,
						storageId: null,
					}
				: null,
		}),
	)
	await requestOk(session, `/account/secrets.json${approvalUrl.search}`, {
		body: { action: 'approve' },
	})
}

async function connectMockIntegration(
	session: RehearsalSession,
	origins: RehearsalOrigins,
) {
	const mockHost = new URL(origins.mockCloudflare).host
	const tokenUrl = `${origins.mockCloudflare}/__mocks/rehearsal/oauth/token`
	const redirectUri = `${origins.app}/connect/oauth`
	const app = {
		provider: integrationName,
		authorizeUrl: `${origins.mockCloudflare}/__mocks/rehearsal/oauth/authorize`,
		tokenUrl,
		apiBaseUrl: origins.mockCloudflare,
		flow: 'confidential',
		clientId: 'rehearsal-client',
		scopeSeparator: ' ',
	}
	await requestOk(session, '/account/secrets.json', {
		body: {
			action: 'save_oauth_app',
			...app,
			clientSecret: 'rehearsal-client-secret',
		},
	})
	const exchange = readRecord(
		await requestOk(session, '/account/secrets.json', {
			body: {
				action: 'oauth_exchange',
				tokenUrl,
				params: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: app.clientId,
					code: `rehearsal-code-${crypto.randomUUID()}`,
					redirect_uri: redirectUri,
				}).toString(),
				flow: app.flow,
				provider: integrationName,
				allowedHosts: [mockHost],
			},
		}),
		'oauth_exchange',
	)
	if (typeof exchange.access_token !== 'string') {
		throw new Error(
			`oauth_exchange returned no access_token: ${JSON.stringify(exchange)}`,
		)
	}
	const connected = readRecord(
		await requestOk(session, '/account/secrets.json', {
			body: {
				action: 'connect_oauth',
				...app,
				callbackUrl: `${redirectUri}?code=rehearsal&state=rehearsal`,
				scopes: ['rehearsal.read'],
				allowedHosts: [mockHost],
				tokenPayload: exchange,
			},
		}),
		'connect_oauth',
	)
	if (connected.accessTokenSaved !== true) {
		throw new Error(
			`connect_oauth did not save an access token: ${JSON.stringify(connected)}`,
		)
	}
}

/** An explicit token lifetime: an alias, or both TTLs in seconds. */
export type TokenLifetime =
	| { lifetime: 'short' | 'long' }
	| { idle_ttl_seconds: number; max_lifetime_seconds: number }

/**
 * The headless CLI login: `cliCredentialBootstrap` over MCP, then the same
 * `POST /v1/tokens/bootstrap/redeem` that `kody auth bootstrap` makes.
 */
export async function mintCliToken(
	session: RehearsalSession,
	origins: RehearsalOrigins,
	name: string,
	lifetime: TokenLifetime,
) {
	const bootstrap = await callCapability(session, 'cliCredentialBootstrap', {
		name,
		scopes: apiTokenScopes,
		...lifetime,
	})
	const code = readStringAt(
		bootstrap,
		['bootstrap_code'],
		'cliCredentialBootstrap',
	)
	const redeemed = await postJson(`${origins.api}/v1/tokens/bootstrap/redeem`, {
		code,
		...lifetime,
	})
	if (redeemed.status !== 200 && redeemed.status !== 201) {
		throw new Error(describeFailure('/v1/tokens/bootstrap/redeem', redeemed))
	}
	return readStringAt(redeemed.body, ['token'], 'bootstrap redeem')
}

async function mintTokens(
	session: RehearsalSession,
	origins: RehearsalOrigins,
	label: string,
) {
	const cliToken = await mintCliToken(
		session,
		origins,
		`rehearsal-cli-${label}`,
		{
			lifetime: 'long',
		},
	)
	const created = await postJson(
		`${origins.api}/v1/tokens`,
		{
			name: `rehearsal-every-scope-${label}`,
			scopes: apiTokenScopes,
			lifetime: 'long',
		},
		{ Authorization: `Bearer ${cliToken}` },
	)
	if (created.status !== 200 && created.status !== 201) {
		throw new Error(describeFailure('/v1/tokens', created))
	}
	return {
		cliToken,
		everyScopeToken: readStringAt(created.body, ['token'], 'tokenCreate'),
	}
}

async function seedPersonData(
	input: SeedInput,
	session: RehearsalSession,
	user: RehearsalUser,
	stableUserId: string,
): Promise<SeededPerson> {
	const log = input.log ?? (() => {})
	const now = input.now ?? (() => new Date())
	const echoUrl = `${input.origins.mockCloudflare}/__mocks/rehearsal/echo`
	const mockHost = new URL(input.origins.mockCloudflare).host

	const userSecretValue = randomSecretValue()
	await callCapability(session, 'secretSet', {
		name: userSecretName,
		value: userSecretValue,
		scope: 'user',
		description: 'Rehearsal user-level secret',
	})
	await approveSecretHost(session, {
		origin: input.origins.app,
		name: userSecretName,
		host: mockHost,
		packageId: null,
	})

	for (const memory of rehearsalMemories) {
		await callCapability(session, 'metaMemoryUpsert', {
			...memory,
			verified_by_agent: true,
		})
	}

	const oneOffRunAt = new Date(now().getTime() + 30 * 86_400_000).toISOString()
	const saved = await callCapability(session, 'packageSave', {
		files: personalPackageFiles({
			username: user.username,
			echoUrl,
			oneOffRunAt,
		}),
	})
	const packageId = readStringAt(saved, ['package_id'], 'packageSave')
	const packageName = `@${user.username}/${personalPackageLeaf}`

	const packageSecretValue = randomSecretValue()
	await session.execute(
		packageExportModule(`kody:${packageName}/set-package-secret`),
		{
			value: packageSecretValue,
		},
	)
	await approveSecretHost(session, {
		origin: input.origins.app,
		name: packageSecretName,
		host: mockHost,
		packageId,
	})

	const minted = await callCapability(session, 'webhookUrlMint', {
		packageId,
		webhookName: 'inbound',
	})
	const jobs = readRecord(
		await callCapability(session, 'jobList', {}),
		'jobList',
	)
	const jobRows = (Array.isArray(jobs.jobs) ? jobs.jobs : []) as Array<
		Record<string, unknown>
	>
	const jobIds = jobRows.flatMap((job) =>
		typeof job.id === 'string' ? [job.id] : [],
	)
	if (jobIds.length < 2) {
		throw new Error(
			`${user.role}: expected two package jobs, got ${JSON.stringify(jobs)}`,
		)
	}
	const recurring = jobRows.find((job) =>
		JSON.stringify(job).includes('daily-digest'),
	)
	if (typeof recurring?.id === 'string') {
		await callCapability(session, 'jobRunNow', { id: recurring.id })
	}

	await connectMockIntegration(session, input.origins)
	const integrationProof = readRecord(
		await session.execute(integrationProofModule(echoUrl)),
		'integration proof',
	)
	if (integrationProof.bearerSent !== true) {
		throw new Error(
			`${user.role}: integration call did not send a bearer token: ${JSON.stringify(integrationProof)}`,
		)
	}

	const userProof = readRecord(
		await session.execute(userSecretProofModule(echoUrl)),
		'user secret proof',
	)
	const packageProof = readRecord(
		await session.execute(
			packageExportModule(`kody:${packageName}/secret-proof`),
		),
		'package secret proof',
	)
	const expectedUserHash = await sha256Hex(userSecretValue)
	const expectedPackageHash = await sha256Hex(packageSecretValue)
	if (userProof.sha256 !== expectedUserHash) {
		throw new Error(
			`${user.role}: user secret proof mismatch ${JSON.stringify(userProof)}`,
		)
	}
	if (packageProof.sha256 !== expectedPackageHash) {
		throw new Error(
			`${user.role}: package secret proof mismatch ${JSON.stringify(packageProof)}`,
		)
	}
	log(
		`  ${user.role}: secrets, memories, package, jobs, webhook, integration ok`,
	)
	return {
		role: user.role,
		email: user.email,
		username: user.username,
		stableUserId,
		origin: user.origin,
		packageId,
		packageName,
		webhookHandle: readStringAt(
			minted,
			['webhook', 'handle'],
			'webhookUrlMint',
		),
		jobIds,
		userSecretSha256: expectedUserHash,
		packageSecretSha256: expectedPackageHash,
	}
}

/** Person roster plus the platform account. A complete seed has all of these. */
export const rehearsalSeedEmails = [
	...rehearsalUsers.map((user) => user.email),
	rehearsalPlatformAccount.email,
] as const

export const rehearsalSeedRosterSize = rehearsalSeedEmails.length

export type RehearsalSeedState = 'empty' | 'partial' | 'complete'

export type RehearsalSeedStatus = {
	workerName: string
	state: RehearsalSeedState
	count: number
	expected: number
	app: RehearsalDatabase
}

export function classifyRehearsalSeedCount(count: number): RehearsalSeedState {
	if (!Number.isFinite(count) || count <= 0) return 'empty'
	if (count >= rehearsalSeedRosterSize) return 'complete'
	return 'partial'
}

export async function rehearsalSeedStatus(
	client: CloudflareClient,
	workerName: string,
): Promise<RehearsalSeedStatus> {
	const app = (await resolveRehearsalDatabases(client, workerName)).find(
		(database) => database.role === 'app',
	)
	if (!app) throw new Error('No app database for this preview.')
	const emails = rehearsalSeedEmails.map((email) => `'${email}'`).join(', ')
	const rows = await queryD1<{ n: number }>(
		client,
		app.uuid,
		`SELECT COUNT(*) AS n FROM users WHERE email IN (${emails})`,
	)
	const count = Number(rows[0]?.n ?? 0)
	return {
		workerName,
		state: classifyRehearsalSeedCount(count),
		count,
		expected: rehearsalSeedRosterSize,
		app,
	}
}

export async function assertNotSeeded(
	client: CloudflareClient,
	workerName: string,
) {
	const status = await rehearsalSeedStatus(client, workerName)
	switch (status.state) {
		case 'empty':
			return status.app
		case 'complete':
			throw new Error(
				`${workerName} already has the full rehearsal roster (${status.count}/${status.expected}). Restore the last successful seed run's pre-seed D1 snapshot (action restore) or use a fresh branch preview, then seed again.`,
			)
		case 'partial':
			throw new Error(
				`${workerName} has a partial rehearsal roster (${status.count}/${status.expected}). Restore the last successful seed run's pre-seed D1 snapshot (action restore), then seed again.`,
			)
		default: {
			const _exhaustive: never = status.state
			throw new Error(`Unknown rehearsal seed state: ${_exhaustive}`)
		}
	}
}

/**
 * Seed §12.2 through the preview's real paths. The only direct D1 writes are
 * the seed-path users (the same SQL `seed-test-data.ts` runs, giving legacy
 * `sha256(email)` ids) and carol's auto-refill settings (no Stripe mock on
 * previews, so the settings route refuses non-Stripe customers).
 */
export async function seedRehearsal(
	input: SeedInput,
): Promise<{ manifest: SeedManifest; credentials: SeedCredentials }> {
	const log = input.log ?? (() => {})
	const now = input.now ?? (() => new Date())
	const appDb = await assertNotSeeded(input.client, input.workerName)

	const passwords = new Map<RehearsalUser['role'], string>()
	for (const user of rehearsalUsers) {
		passwords.set(
			user.role,
			await deriveRehearsalPassword({
				key: input.passwordKey,
				workerName: input.workerName,
				role: user.role,
			}),
		)
	}

	log('Creating seed-path users (legacy sha256(email) ids)...')
	const seedSql: Array<string> = []
	for (const user of rehearsalUsers.filter(
		(entry) => entry.origin === 'seed-sql',
	)) {
		seedSql.push(
			buildSeedUserSql({
				email: user.email,
				username: user.username,
				passwordHash: await createPasswordHash(passwords.get(user.role) ?? ''),
				admin: user.siteAdmin,
			}),
		)
	}
	await queryD1(input.client, appDb.uuid, seedSql.join('\n'))

	const admin = await sessionFor(input, rehearsalUser('admin'))
	const sessions: Array<RehearsalSession> = [admin]
	try {
		const stableIds = new Map<RehearsalUser['role'], string>()
		for (const role of ['admin', 'alice', 'bob'] as const) {
			const found = await callCapability(admin, 'adminUserGet', {
				email: rehearsalUser(role).email,
			})
			stableIds.set(
				role,
				readStringAt(found, ['user', 'stableUserId'], 'adminUserGet'),
			)
		}

		log('Creating carol through adminUserCreate + password setup link...')
		const carol = rehearsalUser('carol')
		const created = await callCapability(admin, 'adminUserCreate', {
			email: carol.email,
			username: carol.username,
		})
		stableIds.set(
			'carol',
			readStringAt(created, ['createdUser', 'stableUserId'], 'adminUserCreate'),
		)
		const setupToken = new URL(
			readStringAt(created, ['createdUser', 'setupLink'], 'adminUserCreate'),
		).searchParams.get('token')
		if (!setupToken) {
			throw new Error('adminUserCreate setupLink has no token parameter.')
		}
		const confirmed = await postJson(
			`${input.origins.app}/password-reset/confirm`,
			{
				token: setupToken,
				password: passwords.get('carol'),
			},
		)
		if (confirmed.status >= 300) {
			throw new Error(describeFailure('/password-reset/confirm', confirmed))
		}

		log('Creating dave through /auth signup + adminUserVerify...')
		const dave = rehearsalUser('dave')
		const signup = await postJson(`${input.origins.app}/auth`, {
			email: dave.email,
			username: dave.username,
			password: passwords.get('dave'),
			mode: 'signup',
		})
		if (signup.status >= 300)
			throw new Error(describeFailure('/auth signup', signup))
		await callCapability(admin, 'adminUserVerify', {
			email: dave.email,
			action: 'mark_verified',
		})
		const daveRecord = await callCapability(admin, 'adminUserGet', {
			email: dave.email,
		})
		stableIds.set(
			'dave',
			readStringAt(daveRecord, ['user', 'stableUserId'], 'adminUserGet'),
		)

		log('Site-admin setup: plans, credits, platform account, scope grant...')
		for (const role of ['alice', 'carol'] as const) {
			await callCapability(admin, 'adminUserUpdate', {
				email: rehearsalUser(role).email,
				plan: 'pro',
			})
		}
		for (const [role, amountCents] of [
			['alice', 2500],
			['bob', 500],
			['carol', 1500],
		] as const) {
			await callCapability(admin, 'adminCreditGrant', {
				email: rehearsalUser(role).email,
				amountCents,
				note: 'Preview migration rehearsal seed',
			})
		}
		await callCapability(admin, 'adminReservedUsernameAdd', {
			usernames: [rehearsalPlatformAccount.username],
		})
		await callCapability(admin, 'adminPlatformAccountCreate', {
			email: rehearsalPlatformAccount.email,
			username: rehearsalPlatformAccount.username,
		})
		await callCapability(admin, 'adminPackageScopeGrantCreate', {
			scope: rehearsalPlatformAccount.username,
			username: rehearsalUser('bob').username,
		})

		const personSessions = new Map<RehearsalUser['role'], RehearsalSession>()
		const people: Array<SeededPerson> = []
		const tokens = new Map<
			RehearsalUser['role'],
			{ cliToken: string; everyScopeToken: string }
		>()
		for (const role of ['alice', 'bob', 'carol', 'dave'] as const) {
			const user = rehearsalUser(role)
			log(`Seeding ${role} (${user.origin})...`)
			const session = await sessionFor(input, user)
			sessions.push(session)
			personSessions.set(role, session)
			people.push(
				await seedPersonData(input, session, user, stableIds.get(role) ?? ''),
			)
			tokens.set(role, await mintTokens(session, input.origins, role))
		}
		tokens.set('admin', await mintTokens(admin, input.origins, 'admin'))

		log(
			'Sharing: alice shares with carol (accepted), carol invites alice (pending)...',
		)
		const alice = personSessions.get('alice')
		const carolSession = personSessions.get('carol')
		if (!alice || !carolSession)
			throw new Error('Missing alice/carol sessions.')
		for (const role of sharingOptInRoles) {
			const session = personSessions.get(role)
			if (!session) throw new Error(`Missing ${role} session.`)
			const optIn = await session.request('/docs/package-sharing/opt-in', {
				method: 'POST',
			})
			if (optIn.status !== 302 || optIn.location?.includes('/login')) {
				throw new Error(describeFailure('/docs/package-sharing/opt-in', optIn))
			}
		}
		const alicePackage = people.find((person) => person.role === 'alice')
		const carolPackage = people.find((person) => person.role === 'carol')
		const accepted = await callCapability(alice, 'packageShareInvite', {
			package_id: alicePackage?.packageId,
			username: rehearsalUser('carol').username,
		})
		const acceptedGrantId = readStringAt(
			accepted,
			['grant', 'grant_id'],
			'packageShareInvite',
		)
		await callCapability(carolSession, 'packageShareAccept', {
			grant_id: acceptedGrantId,
		})
		const guestRun = readRecord(
			await carolSession.execute(
				packageExportModule(`kody:${alicePackage?.packageName}/ping`),
			),
			'guest execute of the shared package',
		)
		if (guestRun.pong !== true) {
			throw new Error(
				`carol could not run alice's package: ${JSON.stringify(guestRun)}`,
			)
		}
		const pending = await callCapability(carolSession, 'packageShareInvite', {
			package_id: carolPackage?.packageId,
			username: rehearsalUser('alice').username,
		})
		const pendingGrantId = readStringAt(
			pending,
			['grant', 'grant_id'],
			'packageShareInvite',
		)

		log(
			'Platform: bob publishes public, private, and hidden platform packages...',
		)
		const bob = personSessions.get('bob')
		const daveSession = personSessions.get('dave')
		if (!bob || !daveSession) throw new Error('Missing bob/dave sessions.')
		const platformScope = rehearsalPlatformAccount.username
		const platformSaved: SeedManifest['platform']['packages'] = []
		let listingId = ''
		for (const entry of platformPackages) {
			const savedPlatform = await callCapability(bob, 'packageSave', {
				files: platformPackageFiles({
					scope: platformScope,
					leaf: entry.leaf,
					description: entry.description,
				}),
				package_scope: platformScope,
			})
			const packageId = readStringAt(
				savedPlatform,
				['package_id'],
				'packageSave',
			)
			platformSaved.push({
				leaf: entry.leaf,
				visibility: entry.visibility,
				packageId,
			})
			switch (entry.visibility) {
				case 'public': {
					const listing = await callCapability(bob, 'communityPublish', {
						package_id: packageId,
						package_scope: platformScope,
					})
					listingId = readStringAt(listing, ['listing_id'], 'communityPublish')
					break
				}
				case 'hidden':
					await callCapability(bob, 'packageUpdate', {
						package_id: packageId,
						package_scope: platformScope,
						changes: { hidden: true },
					})
					break
				case 'private':
					break
				default: {
					const unreachable: never = entry.visibility
					throw new Error(`Unknown visibility ${String(unreachable)}`)
				}
			}
		}
		const fork = await callCapability(daveSession, 'communityFork', {
			listing_id: listingId,
		})
		const forkPackageId = readStringAt(fork, ['package_id'], 'communityFork')

		log(
			'Billing: carol auto-refill settings (direct D1 write; no Stripe mock)...',
		)
		await queryD1(
			input.client,
			appDb.uuid,
			`UPDATE credit_wallets SET auto_refill_enabled = 1, auto_refill_threshold_cents = 500, auto_refill_amount_cents = 2000, auto_refill_monthly_cap_cents = 10000 WHERE user_id = '${stableIds.get('carol')}'`,
		)

		log(`Username history: dave renames to ${renamedDaveUsername}...`)
		await requestOk(daveSession, '/account/profile.json', {
			body: { username: renamedDaveUsername },
		})
		const davePerson = people.find((person) => person.role === 'dave')
		if (davePerson) {
			davePerson.username = renamedDaveUsername
			davePerson.packageName = `@${renamedDaveUsername}/${personalPackageLeaf}`
		}

		const credentials: SeedCredentials = {
			version: 1,
			workerName: input.workerName,
			origins: input.origins,
			users: rehearsalUsers.map((user) => ({
				role: user.role,
				email: user.email,
				username: user.role === 'dave' ? renamedDaveUsername : user.username,
				password: passwords.get(user.role) ?? '',
				cliToken: tokens.get(user.role)?.cliToken ?? '',
				everyScopeToken: tokens.get(user.role)?.everyScopeToken ?? '',
			})),
		}
		const manifest: SeedManifest = {
			version: 1,
			workerName: input.workerName,
			seededAt: now().toISOString(),
			origins: input.origins,
			people: [
				{
					role: 'admin',
					email: rehearsalUser('admin').email,
					username: rehearsalUser('admin').username,
					stableUserId: stableIds.get('admin') ?? '',
					origin: 'seed-sql',
					packageId: null,
					packageName: null,
					webhookHandle: null,
					jobIds: [],
					userSecretSha256: null,
					packageSecretSha256: null,
				},
				...people,
			],
			platform: {
				email: rehearsalPlatformAccount.email,
				username: platformScope,
				scopeGrantee: rehearsalUser('bob').username,
				packages: platformSaved,
				listingId,
				forkedBy: 'dave',
				forkPackageId,
			},
			sharing: { acceptedGrantId, pendingGrantId },
			renamed: {
				from: rehearsalUser('dave').username,
				to: renamedDaveUsername,
			},
			autoRefill: { role: 'carol' },
		}
		return { manifest, credentials }
	} finally {
		for (const session of sessions) await session.close()
	}
}
