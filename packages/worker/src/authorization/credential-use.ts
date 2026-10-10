/**
 * Per-resource credential use checks for actor-attributed ad-hoc resolution.
 *
 * Ad-hoc execute (no package secret authority) must hold `secret:use` /
 * `integration:use` on the concrete org resource. Hosted package runs (bundler-
 * proven identity) use slot binding / allowlist / usageMode / provider grant
 * as the grant: the runner needs `package:execute`, not per-credential Use.
 * CLI `--local` CapabilityProxy may stamp a client package id; that stamp is
 * never secret authority — local hops always require Use like ad-hoc.
 * Automation is Owner and passes `authorize`. See ADR 0021 (amended).
 */
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { authorize, type OrgResource } from './authorize.ts'

export function secretUseResource(input: {
	orgUserId: string
	name: string
}): OrgResource {
	return {
		type: 'secret',
		id: input.name,
		orgId: ownerIdFromStored(input.orgUserId),
		label: input.name,
	}
}

export function integrationUseResource(input: {
	orgUserId: string
	name: string
}): OrgResource {
	return {
		type: 'integration',
		id: input.name,
		orgId: ownerIdFromStored(input.orgUserId),
		label: input.name,
	}
}

/**
 * When there is no package secret authority, the acting person must hold
 * `secret:use` on this secret. Package-authority runs skip this: package
 * attachment / mounts are the grant for that path.
 */
export async function authorizeAmbientSecretUse(input: {
	env: Env
	request: RequestContext | null
	orgUserId: string
	secretName: string
	authorityPackageId: string | null | undefined
}): Promise<void> {
	if (input.authorityPackageId) return
	await authorize(
		{ env: input.env, request: input.request },
		'secret:use',
		secretUseResource({
			orgUserId: input.orgUserId,
			name: input.secretName,
		}),
	)
}

/**
 * When there is no package secret authority, the acting person must hold
 * `integration:use` on this integration (or MCP server named as integration
 * resource id). Package-authority runs skip this: usageMode / allowed
 * packages are the grant for that path.
 */
export async function authorizeAmbientIntegrationUse(input: {
	env: Env
	request: RequestContext | null
	orgUserId: string
	integrationName: string
	authorityPackageId: string | null | undefined
}): Promise<void> {
	if (input.authorityPackageId) return
	await authorize(
		{ env: input.env, request: input.request },
		'integration:use',
		integrationUseResource({
			orgUserId: input.orgUserId,
			name: input.integrationName,
		}),
	)
}
