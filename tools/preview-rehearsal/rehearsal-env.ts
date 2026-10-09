import { cloudflareApiRequest } from '../ci/resource-utils.ts'
import {
	assertRehearsalWorkerName,
	type CloudflareClient,
} from './d1-rehearsal.ts'

/**
 * How each rehearsal person account comes into existence. §12.2 needs both
 * id shapes: seed-path users get the legacy `sha256(email)` stable id, while
 * admin-created and self-signup users get random ids.
 */
export type RehearsalUserOrigin = 'seed-sql' | 'admin-create' | 'signup'

export type RehearsalUser = {
	role: 'admin' | 'alice' | 'bob' | 'carol' | 'dave'
	email: string
	username: string
	origin: RehearsalUserOrigin
	siteAdmin: boolean
}

/**
 * Fixed roster. Each preview has its own APP_DB and Vectorize index, so the
 * same emails on two rehearsal previews never collide.
 *
 * - admin: private-credential site admin (seed SQL path, `--admin` role).
 * - alice: paid; owns the shared package; seed SQL (legacy id).
 * - bob: holds the platform scope grant and publishes there; seed SQL.
 * - carol: paid; accepted alice's share and invited alice (pending);
 *   admin-created (random id); auto-refill configured.
 * - dave: real signup (random id); forked the platform listing; renamed.
 */
export const rehearsalUsers: ReadonlyArray<RehearsalUser> = [
	{
		role: 'admin',
		email: 'rh-admin@example.com',
		username: 'rh-admin',
		origin: 'seed-sql',
		siteAdmin: true,
	},
	{
		role: 'alice',
		email: 'rh-alice@example.com',
		username: 'rh-alice',
		origin: 'seed-sql',
		siteAdmin: false,
	},
	{
		role: 'bob',
		email: 'rh-bob@example.com',
		username: 'rh-bob',
		origin: 'seed-sql',
		siteAdmin: false,
	},
	{
		role: 'carol',
		email: 'rh-carol@example.com',
		username: 'rh-carol',
		origin: 'admin-create',
		siteAdmin: false,
	},
	{
		role: 'dave',
		email: 'rh-dave@example.com',
		username: 'rh-dave',
		origin: 'signup',
		siteAdmin: false,
	},
]

/** Dave renames during the seed so `username_redirects` has a row. */
export const renamedDaveUsername = 'rh-dave-renamed'

export const rehearsalPlatformAccount = {
	email: 'rh-platform@example.com',
	username: 'rh-platform',
} as const

/** Fixture user `preview.yml` reseeds on every deploy; excluded from diffs. */
export const previewFixtureEmail = 'me@kentcdodds.com'

export function rehearsalUser(role: RehearsalUser['role']) {
	const user = rehearsalUsers.find((entry) => entry.role === role)
	if (!user) throw new Error(`Unknown rehearsal role ${role}.`)
	return user
}

/**
 * Passwords are derived, not stored: HMAC-SHA256 of the preview name and role
 * under the CI Cloudflare API token. Every workflow run can sign in as every
 * rehearsal user without persisting state, agents never hold the key, and the
 * derivation adds no exposure (the token already controls these D1s).
 */
export async function deriveRehearsalPassword(input: {
	key: string
	workerName: string
	role: RehearsalUser['role']
}) {
	if (!input.key.trim()) {
		throw new Error('Missing rehearsal password key (REHEARSAL_PASSWORD_KEY).')
	}
	assertRehearsalWorkerName(input.workerName)
	const hmacKey = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(input.key),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		hmacKey,
		new TextEncoder().encode(
			`kody-preview-rehearsal/v1/${input.workerName}/${input.role}`,
		),
	)
	return `Rh-${Buffer.from(signature).toString('base64url').slice(0, 32)}`
}

export type RehearsalOrigins = {
	app: string
	api: string
	mockCloudflare: string
}

export function rehearsalOrigins(
	workerName: string,
	workersSubdomain: string,
): RehearsalOrigins {
	assertRehearsalWorkerName(workerName)
	const host = (name: string) =>
		`https://${name}.${workersSubdomain}.workers.dev`
	return {
		app: host(workerName),
		api: host(`${workerName}-api`),
		mockCloudflare: host(`${workerName}-mock-cloudflare`),
	}
}

export async function resolveRehearsalOrigins(
	client: CloudflareClient,
	workerName: string,
) {
	const response = await cloudflareApiRequest<{ subdomain?: string }>({
		...client,
		pathname: '/workers/subdomain',
	})
	const subdomain = response.result?.subdomain?.trim()
	if (!subdomain) {
		throw new Error('Cloudflare returned no workers.dev subdomain.')
	}
	return rehearsalOrigins(workerName, subdomain)
}
