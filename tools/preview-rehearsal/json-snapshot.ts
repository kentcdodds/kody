import { buildPackageAppUrl } from '@kody-internal/shared/public-urls.ts'
import { openRehearsalSession, type RehearsalSession } from './kody-session.ts'
import {
	rehearsalOrg,
	type RehearsalOrigins,
	type RehearsalUser,
} from './rehearsal-env.ts'
import {
	appMarker,
	memoryQueries,
	personalPackageLeaf,
} from './rehearsal-packages.ts'
import {
	callCapability,
	integrationProofModule,
	packageExportModule,
	userSecretProofModule,
} from './seed.ts'

export type SnapshotUser = {
	role: RehearsalUser['role']
	email: string
	username: string
	password: string
}

/**
 * Keys that change on every read or every job tick. Dropped so two snapshots
 * of an idle preview diff clean; job schedules keep `next_run_at`.
 */
const volatileKeyPattern =
	/^(last_[a-z_]+|lastUsedAt|updated_at|updatedAt|serverTiming|alarm|timing|phase_timings|warning|warnings|mutation_guidance|day|weekStart)$/

export function stripVolatile(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripVolatile)
	if (!value || typeof value !== 'object') return value
	const out: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(value)) {
		if (volatileKeyPattern.test(key)) continue
		out[key] = stripVolatile(entry)
	}
	return out
}

/**
 * The inline app path on previews intermittently answers 500 or a login
 * redirect for a valid session; a persistent failure still shows up.
 */
const appAttempts = 3
const appRetryDelayMs = 2_000
const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms))

/** MCP errors carry a per-call conversation id. */
function normalizeErrorMessage(message: string) {
	return message.replace(/conversationId: \S+/g, 'conversationId: <id>')
}

export type SnapshotCheckFailure = { check: string; error: string }

type Capture = (check: string, fn: () => Promise<unknown>) => Promise<unknown>

/**
 * Every captured read is a required check: a failure is kept in the snapshot
 * for diagnosis and listed in `failures`, so the run fails even when the
 * before and after snapshots fail identically.
 */
function createCapture(failures: Array<SnapshotCheckFailure>): Capture {
	return async (check, fn) => {
		try {
			return stripVolatile(await fn())
		} catch (error) {
			const message = normalizeErrorMessage(
				error instanceof Error ? error.message : String(error),
			)
			failures.push({ check, error: message })
			return { error: message }
		}
	}
}

function memoryMatchesSummary(result: unknown) {
	const matches = (result as { matches?: Array<Record<string, unknown>> })
		?.matches
	if (!Array.isArray(matches)) return result
	return matches.map((match) => ({
		id: match.id ?? match.memory_id ?? null,
		subject: match.subject ?? null,
	}))
}

async function snapshotPerson(
	session: RehearsalSession,
	user: SnapshotUser,
	origins: RehearsalOrigins,
	capture: Capture,
) {
	const check = (name: string) => `${user.role}.${name}`
	const echoUrl = `${origins.mockCloudflare}/__mocks/rehearsal/echo`
	const packageName = `@${user.username}/${personalPackageLeaf}`
	const appUrl = buildPackageAppUrl({
		origin: origins.app,
		username: user.username,
		kodyId: personalPackageLeaf,
	})
	const memorySearches: Record<string, unknown> = {}
	for (const query of memoryQueries) {
		memorySearches[query] = await capture(
			check(`memorySearch:${query}`),
			async () =>
				memoryMatchesSummary(
					await callCapability(session, 'metaMemorySearch', {
						query,
						limit: 3,
					}),
				),
		)
	}
	return {
		role: user.role,
		me: await capture(check('me'), () =>
			callCapability(session, 'metaGetCurrentUser'),
		),
		packages: await capture(check('packages'), () =>
			callCapability(session, 'packageList'),
		),
		appUrl,
		app: await capture(check('app'), async () => {
			let attempt = 0
			for (;;) {
				attempt += 1
				try {
					const response = await session.request(new URL(appUrl).pathname)
					const servesApp =
						typeof response.body === 'string' &&
						response.body.includes(appMarker)
					if (servesApp || attempt === appAttempts) {
						return { status: response.status, servesApp }
					}
				} catch (error) {
					if (attempt === appAttempts) throw error
				}
				await sleep(appRetryDelayMs)
			}
		}),
		jobs: await capture(check('jobs'), async () => {
			const listed = (await callCapability(session, 'jobList')) as {
				jobs?: Array<Record<string, unknown>>
			}
			return (listed.jobs ?? []).map((job) => ({
				id: job.id,
				name: job.name,
				enabled: job.enabled,
				schedule_summary: job.schedule_summary,
				next_run_at: job.next_run_at ?? null,
			}))
		}),
		webhooks: await capture(check('webhooks'), () =>
			callCapability(session, 'webhookList'),
		),
		secrets: await capture(check('secrets'), () =>
			callCapability(session, 'secretList'),
		),
		secretProofs: {
			user: await capture(check('secretProof.user'), () =>
				session.execute(userSecretProofModule(echoUrl)),
			),
			package: await capture(check('secretProof.package'), () =>
				session.execute(
					packageExportModule(`kody:${packageName}/secret-proof`),
				),
			),
		},
		integrations: await capture(check('integrations'), () =>
			callCapability(session, 'integrationList'),
		),
		integrationProof: await capture(check('integrationProof'), () =>
			session.execute(integrationProofModule(echoUrl)),
		),
		memorySearches,
		grants: await capture(check('grants'), () =>
			callCapability(session, 'accessList'),
		),
		tokens: await capture(check('tokens'), async () => {
			const listed = (await session.api('tokenList')) as {
				tokens?: Array<Record<string, unknown>>
			}
			return (listed?.tokens ?? []).map((token) => ({
				id: token.id,
				name: token.name,
				scopes: token.scopes,
			}))
		}),
		/**
		 * Not compared by `diffSnapshots`: every snapshot's own execute calls
		 * (and job runs) move the counters.
		 */
		observed: {
			usage: await capture(check('usage'), () =>
				callCapability(session, 'usageGet'),
			),
		},
	}
}

/**
 * The org owner's MCP connection binds to the rehearsal org only while the
 * owner membership is live; its package list is the org's, not the owner's.
 */
async function snapshotOrg(
	origins: RehearsalOrigins,
	owner: SnapshotUser,
	capture: Capture,
) {
	const check = (name: string) => `org.${name}`
	let session: RehearsalSession
	try {
		session = await openRehearsalSession(origins.app, owner, {
			orgSlug: rehearsalOrg.slug,
		})
	} catch (error) {
		return {
			slug: rehearsalOrg.slug,
			session: await capture(check('session'), async () => {
				throw error
			}),
		}
	}
	try {
		return {
			slug: rehearsalOrg.slug,
			me: await capture(check('me'), () =>
				callCapability(session, 'metaGetCurrentUser'),
			),
			packages: await capture(check('packages'), () =>
				callCapability(session, 'packageList'),
			),
			grants: await capture(check('grants'), () =>
				callCapability(session, 'accessList'),
			),
		}
	} finally {
		await session.close()
	}
}

export type JsonSnapshot = {
	version: 1
	takenAt: string
	origins: RehearsalOrigins
	admin: Record<string, unknown>
	people: Array<Awaited<ReturnType<typeof snapshotPerson>>>
	org: Awaited<ReturnType<typeof snapshotOrg>>
	failures: Array<SnapshotCheckFailure>
}

/**
 * §12.2 step 3 through Kody's own JSON surfaces (MCP execute/api plus the
 * session routes), signed in as each rehearsal user. Runs anywhere the
 * credentials are available: the workflow derives them, an operator passes
 * the opened credentials file.
 */
export async function takeJsonSnapshot(input: {
	origins: RehearsalOrigins
	users: ReadonlyArray<SnapshotUser>
	now?: () => Date
	log?: (line: string) => void
}): Promise<JsonSnapshot> {
	const log = input.log ?? (() => {})
	const adminUser = input.users.find((user) => user.role === 'admin')
	if (!adminUser)
		throw new Error('Snapshot needs the rehearsal admin credentials.')
	const failures: Array<SnapshotCheckFailure> = []
	const capture = createCapture(failures)
	const admin = await openRehearsalSession(input.origins.app, adminUser)
	const adminView: Record<string, unknown> = {}
	try {
		for (const user of input.users) {
			adminView[user.role] = {
				user: await capture(`admin.${user.role}.user`, () =>
					callCapability(admin, 'adminUserGet', { email: user.email }),
				),
				wallet: await capture(`admin.${user.role}.wallet`, () =>
					callCapability(admin, 'adminCreditWalletGet', { email: user.email }),
				),
			}
		}
	} finally {
		await admin.close()
	}
	const people: JsonSnapshot['people'] = []
	for (const user of input.users.filter((entry) => entry.role !== 'admin')) {
		log(`Snapshotting ${user.role}...`)
		const session = await openRehearsalSession(input.origins.app, user)
		try {
			people.push(await snapshotPerson(session, user, input.origins, capture))
		} finally {
			await session.close()
		}
	}
	const orgOwner = input.users.find((user) => user.role === rehearsalOrg.owner)
	if (!orgOwner) {
		throw new Error(
			`Snapshot needs the rehearsal org owner (${rehearsalOrg.owner}) credentials.`,
		)
	}
	log(`Snapshotting @${rehearsalOrg.slug} as ${orgOwner.role}...`)
	const org = await snapshotOrg(input.origins, orgOwner, capture)
	return {
		version: 1,
		takenAt: (input.now ?? (() => new Date()))().toISOString(),
		origins: input.origins,
		admin: adminView,
		people,
		org,
		failures,
	}
}

export type SnapshotDifference = {
	path: string
	before: unknown
	after: unknown
}

/**
 * Structural diff of two snapshots (or any JSON values), ignoring `takenAt`
 * and every `observed` section.
 */
export function diffSnapshots(
	before: unknown,
	after: unknown,
	path = '',
): Array<SnapshotDifference> {
	if (path === '.takenAt' || path.endsWith('.observed')) return []
	if (
		before &&
		after &&
		typeof before === 'object' &&
		typeof after === 'object' &&
		Array.isArray(before) === Array.isArray(after)
	) {
		const keys = new Set([...Object.keys(before), ...Object.keys(after)])
		return [...keys]
			.sort()
			.flatMap((key) =>
				diffSnapshots(
					(before as Record<string, unknown>)[key],
					(after as Record<string, unknown>)[key],
					Array.isArray(before) ? `${path}[${key}]` : `${path}.${key}`,
				),
			)
	}
	return JSON.stringify(before) === JSON.stringify(after)
		? []
		: [{ path, before, after }]
}
