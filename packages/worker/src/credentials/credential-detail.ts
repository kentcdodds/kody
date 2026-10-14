/**
 * What the Credentials detail pane adds to a list row: the placeholder that
 * fills it, the team orgs a personal credential is granted to, and which of
 * the org's package needs it can fill. Reads no value.
 */
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import * as Sentry from '@sentry/cloudflare'
import { type CredentialListItem } from '#universal/credential-contracts.ts'
import {
	type AccountCredentialDetail,
	type CredentialNeedFit,
} from '#universal/credentials-list.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	listUsableCredentials,
	resolveNeedCandidates,
} from './credential-candidates.ts'
import { loadPublishedCredentialNeeds } from './credential-needs-closure.ts'

/** Each package costs a closure read, so usage checks the most recent ones. */
export const maxUsagePackages = 40

const placeholderNamePattern = /^[a-zA-Z0-9._-]+$/

/**
 * The placeholder code writes for `credential`, or null when none reaches it.
 * Placeholders and `credential()` resolve the same set, so a personal
 * credential granted to the bound org shows the same placeholder as an org
 * credential (it still only works in the owner's runs).
 */
export function credentialPlaceholder(credential: CredentialListItem) {
	if (!placeholderNamePattern.test(credential.name)) return null
	switch (credential.kind) {
		case 'secret':
			return credential.packageId
				? `{{secret:${credential.name}|scope=package}}`
				: `{{secret:${credential.name}}}`
		case 'oauth':
			return `{{integration-token:${credential.name}}}`
		case 'mcp':
		case 'url':
		case 'login':
		case 'signing':
			return null
		default: {
			const exhaustive: never = credential.kind
			return exhaustive
		}
	}
}

async function listGrants(db: D1Database, credentialId: string) {
	const result = await db
		.prepare(
			`SELECT o.slug AS slug, COALESCE(o.display_name, o.slug) AS name,
				g.created_at AS created_at
			FROM credential_org_grants g JOIN orgs o ON o.id = g.org_id
			WHERE g.credential_id = ? AND o.deleted_at IS NULL
			ORDER BY o.slug`,
		)
		.bind(credentialId)
		.all<{ slug: string; name: string; created_at: string }>()
	return (result.results ?? []).map((row) => ({
		orgSlug: row.slug,
		orgName: row.name,
		grantedAt: row.created_at,
	}))
}

async function listUsage(input: {
	env: Env
	request: RequestContext
	orgId: string
	credentialId: string
	packages: ReadonlyArray<SavedPackageRecord>
}) {
	const [usable, closures] = await Promise.all([
		listUsableCredentials({ env: input.env, request: input.request }),
		Promise.all(
			input.packages.map(async (pkg) => ({
				pkg,
				needs: await loadPublishedCredentialNeeds({
					env: input.env,
					userId: input.orgId,
					sourceId: pkg.sourceId,
				}).catch((error: unknown) => {
					Sentry.captureException(error, {
						tags: { scope: 'credentials.detail.usage' },
						extra: { packageId: pkg.id },
					})
					return null
				}),
			})),
		),
	])
	const usage: AccountCredentialDetail['usage'] = []
	let unreadable = 0
	for (const { pkg, needs } of closures) {
		if (needs === null) {
			unreadable += 1
			continue
		}
		for (const need of needs) {
			const resolution = resolveNeedCandidates(need, usable)
			const fit: CredentialNeedFit | null =
				resolution.autoPick?.id === input.credentialId
					? 'auto'
					: resolution.candidates.some((c) => c.id === input.credentialId)
						? 'candidate'
						: resolution.possibleMatches.some(
									(c) => c.id === input.credentialId,
							  )
							? 'possible'
							: null
			if (fit) {
				usage.push({
					packageId: pkg.id,
					kodyId: pkg.kodyId,
					needKey: need.key,
					fit,
				})
			}
		}
	}
	return {
		usage: usage.sort(
			(left, right) =>
				left.kodyId.localeCompare(right.kodyId) ||
				left.needKey.localeCompare(right.needKey),
		),
		unreadable,
	}
}

export async function loadCredentialDetail(input: {
	env: Env
	request: RequestContext
	orgId: string
	/** The viewer's own credential, so its team-org grants are theirs to see. */
	ownedByViewer: boolean
	credential: CredentialListItem
	/** The org's packages, most recently updated first. */
	packages: ReadonlyArray<SavedPackageRecord>
}): Promise<AccountCredentialDetail> {
	// A package key fills its own package's placeholders, never declared needs,
	// and a locked credential is never picked for a package outside its locks.
	const locks = input.credential.lockedToPackageIds
	const reachable =
		locks.length > 0
			? input.packages.filter((pkg) => locks.includes(pkg.id))
			: input.packages
	const checked = input.credential.packageId
		? []
		: reachable.slice(0, maxUsagePackages)
	const [grants, usage] = await Promise.all([
		input.ownedByViewer
			? listGrants(input.env.APP_DB, input.credential.id)
			: [],
		checked.length > 0
			? listUsage({
					env: input.env,
					request: input.request,
					orgId: input.orgId,
					credentialId: input.credential.id,
					packages: checked,
				})
			: { usage: [], unreadable: 0 },
	])
	return {
		id: input.credential.id,
		placeholder: credentialPlaceholder(input.credential),
		grants,
		usage: usage.usage,
		usageTruncated:
			!input.credential.packageId && reachable.length > checked.length,
		usageUnreadable: usage.unreadable,
	}
}
