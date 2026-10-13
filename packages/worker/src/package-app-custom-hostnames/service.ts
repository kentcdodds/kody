import { parseStripePlanName } from '#universal/plans.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { CloudflareCustomHostnamesClient } from '#worker/package-app-custom-hostnames/cloudflare-custom-hostnames-client.ts'
import { isPackageAppCustomDomainsEnabled } from '#worker/package-app-custom-hostnames/feature-flag.ts'
import { normalizeCustomHostname } from '#worker/package-app-custom-hostnames/lookup.ts'
import {
	type PackageAppCustomHostnameBindingKind,
	type PackageAppCustomHostnameRow,
} from '#worker/package-app-custom-hostnames/types.ts'

export class PackageAppCustomHostnameError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PackageAppCustomHostnameError'
	}
}

type CustomHostnameRowSql = {
	id: string
	hostname: string
	binding_kind: string
	package_id: string | null
	org_id: string | null
	cloudflare_hostname_id: string | null
	cloudflare_zone_id: string | null
	hostname_status: string
	ssl_status: string
	verified_at: string | null
	dns_missing_since: string | null
	created_by_user_id: string | null
	created_at: string
	updated_at: string
}

function rowFromSql(row: CustomHostnameRowSql): PackageAppCustomHostnameRow {
	return {
		id: row.id,
		hostname: row.hostname,
		bindingKind: row.binding_kind as PackageAppCustomHostnameBindingKind,
		packageId: row.package_id,
		orgId: row.org_id,
		cloudflareHostnameId: row.cloudflare_hostname_id,
		cloudflareZoneId: row.cloudflare_zone_id,
		hostnameStatus: row.hostname_status,
		sslStatus: row.ssl_status,
		verifiedAt: row.verified_at,
		dnsMissingSince: row.dns_missing_since,
		createdByUserId: row.created_by_user_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function publicRow(row: PackageAppCustomHostnameRow) {
	return {
		id: row.id,
		hostname: row.hostname,
		binding_kind: row.bindingKind,
		package_id: row.packageId,
		org_id: row.orgId,
		hostname_status: row.hostnameStatus,
		ssl_status: row.sslStatus,
		verified_at: row.verifiedAt,
		dns_missing_since: row.dnsMissingSince,
		created_at: row.createdAt,
		updated_at: row.updatedAt,
	}
}

async function requireCustomDomainsEnabled(db: D1Database) {
	if (!(await isPackageAppCustomDomainsEnabled(db))) {
		throw new PackageAppCustomHostnameError(
			'Package-app custom domains are not enabled for this environment.',
		)
	}
}

function createCloudflareClient(env: Env & { fetcher?: Fetcher }) {
	return new CloudflareCustomHostnamesClient({
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN:
			env.CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN,
		PACKAGE_APP_ZONE_ID: env.PACKAGE_APP_ZONE_ID,
		fetcher: env.fetcher,
	})
}

function dnsTargetHostname(env: Env) {
	const base = env.PACKAGE_APP_BASE_URL?.trim()
	if (!base) return null
	try {
		return new URL(base).hostname
	} catch {
		return null
	}
}

async function countOrgCustomHostnames(db: D1Database, orgId: string) {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM package_app_custom_hostnames ch
			 WHERE ch.org_id = ?
			    OR ch.package_id IN (
			      SELECT id FROM saved_packages WHERE user_id = ?${andLiveDeletedAtSql('saved_packages')}
			    )`,
		)
		.bind(orgId, orgId)
		.first<{ count: number }>()
	return row?.count ?? 0
}

async function billingNoteForAdd(db: D1Database, orgId: string) {
	const org = await db
		.prepare(
			`SELECT stripe_plan FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<{ stripe_plan: string | null }>()
	const paidPlan = parseStripePlanName(org?.stripe_plan ?? null)
	if (!paidPlan || paidPlan === 'free') return null
	const count = await countOrgCustomHostnames(db, orgId)
	if (count <= 1) return null
	return 'Paying orgs include one custom domain at no extra charge. Additional domains are $0.10/month each once billing is wired (ADR 0071); this environment does not charge yet.'
}

export async function addPackageAppCustomHostname(input: {
	env: Env
	orgId: string
	createdByUserId: string
	bindingKind: PackageAppCustomHostnameBindingKind
	hostname: string
	packageId?: string
}) {
	await requireCustomDomainsEnabled(input.env.APP_DB)
	const hostname = normalizeCustomHostname(input.hostname)
	if (!hostname) {
		throw new PackageAppCustomHostnameError('hostname is not a valid DNS name.')
	}
	const now = new Date().toISOString()
	const id = crypto.randomUUID()
	let cloudflareHostnameId: string | null = null
	let cloudflareZoneId: string | null = null
	let hostnameStatus = 'pending'
	let sslStatus = 'pending'

	switch (input.bindingKind) {
		case 'app': {
			const packageId = input.packageId?.trim()
			if (!packageId) {
				throw new PackageAppCustomHostnameError(
					'package_id is required for an app-level custom hostname.',
				)
			}
			const saved = await getSavedPackageById(input.env.APP_DB, {
				userId: input.orgId,
				packageId,
			})
			if (!saved) {
				throw new PackageAppCustomHostnameError(
					'Package not found in this organization.',
				)
			}
			if (!saved.isInternetVisible) {
				throw new PackageAppCustomHostnameError(
					'App-level custom hostnames are only for internet-visible (public) package apps. Use an org-level domain for private apps.',
				)
			}
			const client = createCloudflareClient(input.env)
			const cf = await client.addCustomHostname({ hostname })
			cloudflareHostnameId = cf.id
			cloudflareZoneId = input.env.PACKAGE_APP_ZONE_ID?.trim() ?? null
			hostnameStatus = cf.hostnameStatus
			sslStatus = cf.sslStatus ?? 'pending'
			await input.env.APP_DB.prepare(
				`INSERT INTO package_app_custom_hostnames (
						id, hostname, binding_kind, package_id, org_id,
						cloudflare_hostname_id, cloudflare_zone_id,
						hostname_status, ssl_status, created_by_user_id,
						created_at, updated_at
					) VALUES (?, ?, 'app', ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(
					id,
					hostname,
					packageId,
					cloudflareHostnameId,
					cloudflareZoneId,
					hostnameStatus,
					sslStatus,
					input.createdByUserId,
					now,
					now,
				)
				.run()
			break
		}
		case 'org': {
			const client = createCloudflareClient(input.env)
			const cf = await client.addCustomHostname({ hostname })
			cloudflareHostnameId = cf.id
			cloudflareZoneId = input.env.PACKAGE_APP_ZONE_ID?.trim() ?? null
			hostnameStatus = cf.hostnameStatus
			sslStatus = cf.sslStatus ?? 'pending'
			await input.env.APP_DB.prepare(
				`INSERT INTO package_app_custom_hostnames (
						id, hostname, binding_kind, package_id, org_id,
						cloudflare_hostname_id, cloudflare_zone_id,
						hostname_status, ssl_status, created_by_user_id,
						created_at, updated_at
					) VALUES (?, ?, 'org', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(
					id,
					hostname,
					input.orgId,
					cloudflareHostnameId,
					cloudflareZoneId,
					hostnameStatus,
					sslStatus,
					input.createdByUserId,
					now,
					now,
				)
				.run()
			break
		}
		default: {
			input.bindingKind satisfies never
			throw new PackageAppCustomHostnameError('binding_kind is invalid.')
		}
	}

	const row = await input.env.APP_DB.prepare(
		`SELECT * FROM package_app_custom_hostnames WHERE id = ?`,
	)
		.bind(id)
		.first<CustomHostnameRowSql>()
	if (!row) {
		throw new PackageAppCustomHostnameError(
			'Custom hostname row was not stored.',
		)
	}
	const billingNote = await billingNoteForAdd(input.env.APP_DB, input.orgId)
	return {
		hostname: publicRow(rowFromSql(row)),
		dns: {
			type: 'CNAME' as const,
			name: hostname,
			target: dnsTargetHostname(input.env),
		},
		billing_note: billingNote,
	}
}

export async function listPackageAppCustomHostnames(input: {
	env: Env
	orgId: string
}) {
	await requireCustomDomainsEnabled(input.env.APP_DB)
	const rows = await input.env.APP_DB.prepare(
		`SELECT * FROM package_app_custom_hostnames
			 WHERE org_id = ?
			    OR package_id IN (
			      SELECT id FROM saved_packages WHERE user_id = ?${andLiveDeletedAtSql('saved_packages')}
			    )
			 ORDER BY created_at ASC`,
	)
		.bind(input.orgId, input.orgId)
		.all<CustomHostnameRowSql>()
	return {
		hostnames: (rows.results ?? []).map((row) => publicRow(rowFromSql(row))),
	}
}

export async function removePackageAppCustomHostnameRow(input: {
	env: Env
	row: PackageAppCustomHostnameRow
}) {
	if (input.row.cloudflareHostnameId?.trim()) {
		const client = createCloudflareClient(input.env)
		await client.deleteCustomHostname({ id: input.row.cloudflareHostnameId })
	}
	await input.env.APP_DB.prepare(
		`DELETE FROM package_app_custom_hostnames WHERE id = ?`,
	)
		.bind(input.row.id)
		.run()
}

export async function deletePackageAppCustomHostname(input: {
	env: Env
	orgId: string
	hostname?: string
	id?: string
}) {
	await requireCustomDomainsEnabled(input.env.APP_DB)
	const hostname = input.hostname
		? normalizeCustomHostname(input.hostname)
		: null
	const id = input.id?.trim() || null
	if (!hostname && !id) {
		throw new PackageAppCustomHostnameError('Pass hostname or id.')
	}
	const row = hostname
		? await input.env.APP_DB.prepare(
				`SELECT * FROM package_app_custom_hostnames WHERE hostname = ?`,
			)
				.bind(hostname)
				.first<CustomHostnameRowSql>()
		: await input.env.APP_DB.prepare(
				`SELECT * FROM package_app_custom_hostnames WHERE id = ?`,
			)
				.bind(id)
				.first<CustomHostnameRowSql>()
	if (!row) {
		throw new PackageAppCustomHostnameError('Custom hostname not found.')
	}
	const owned =
		row.org_id === input.orgId ||
		(row.package_id &&
			(await getSavedPackageById(input.env.APP_DB, {
				userId: input.orgId,
				packageId: row.package_id,
			})) !== null)
	if (!owned) {
		throw new PackageAppCustomHostnameError(
			'This custom hostname does not belong to the bound organization.',
		)
	}
	await removePackageAppCustomHostnameRow({
		env: input.env,
		row: rowFromSql(row),
	})
	return { ok: true as const, id: row.id, hostname: row.hostname }
}

export async function listPackageAppCustomHostnamesForReconcile(
	db: D1Database,
	input: { limit: number; afterId?: string },
) {
	const after = input.afterId ?? ''
	const rows = await db
		.prepare(
			`SELECT * FROM package_app_custom_hostnames
			 WHERE id > ?
			 ORDER BY id ASC
			 LIMIT ?`,
		)
		.bind(after, input.limit)
		.all<CustomHostnameRowSql>()
	return (rows.results ?? []).map(rowFromSql)
}
