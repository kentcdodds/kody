import { z } from 'zod'
import { findCredentialIdsByLegacyName } from '#worker/credentials/credential-ids.ts'
import {
	assertLoginExchangeOnHosts,
	assertOptInCredentialValue,
	credentialHostsSchema,
	credentialInjectSchema,
	credentialProviderSchema,
	loginExchangeSchema,
	normalizeCredentialHosts,
	type OptInStoredCredentialKind,
	optInStoredCredentialKinds,
	readStoredCredentialPlacement,
	setStoredCredentialKind,
	updateCredentialFields,
} from '#worker/credentials/credential-fields.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { type secretScopeValues } from '#mcp/secrets/types.ts'
import { type toSecretCapabilityOutput } from './shared.ts'

const storedKindValues = ['secret', ...optInStoredCredentialKinds] as const

type StoredKind = (typeof storedKindValues)[number]

export const optInCredentialInputFields = {
	kind: z
		.enum(storedKindValues)
		.optional()
		.describe(
			'Optional credential kind (ADR 0068), set together with a value. "secret" (default) is a Key used by `{{secret:name}}` placeholders. "url", "login", and "signing" are opt-in kinds a package reads through a scoped credential client, never as raw text; they need `hosts`.',
		),
	hosts: credentialHostsSchema
		.optional()
		.describe(
			'Hosts an opt-in kind may be sent to: exact hosts or one wildcard level such as *.example.com. Set together with a value. Keys keep using host approvals instead.',
		),
	login_exchange: loginExchangeSchema
		.optional()
		.describe(
			'For kind "login": how the login fields are exchanged for a session token. Its url must be on one of `hosts`.',
		),
	provider: credentialProviderSchema
		.nullable()
		.optional()
		.describe(
			'Optional provider slug (for example "github") a scoped credential client matches package needs against. Null clears it. Keys used by placeholders ignore it.',
		),
	inject: credentialInjectSchema
		.optional()
		.describe(
			'Optional placement for a scoped credential client: a header with a "{value}" format, basic auth, or a query parameter. Defaults to `Authorization: Bearer {value}`. Placeholders ignore it.',
		),
}

type OptInInput = {
	name: string
	scope: (typeof secretScopeValues)[number]
	value?: string
	kind?: StoredKind
	hosts?: Array<string>
	login_exchange?: z.infer<typeof loginExchangeSchema>
	provider?: string | null
	inject?: z.infer<typeof credentialInjectSchema>
}

export type OptInCredentialPlan = {
	setKind: {
		kind: StoredKind
		hosts: Array<string>
		loginExchange: z.infer<typeof loginExchangeSchema> | null
	} | null
	fields: { provider?: string | null; inject?: OptInInput['inject'] } | null
	reportKind: StoredKind | null
}

function isOptInKind(kind: StoredKind): kind is OptInStoredCredentialKind {
	return kind !== 'secret'
}

/**
 * Validates the opt-in fields before anything is written, so a bad kind,
 * host, or value fails without touching the stored secret. Only the org's
 * own user scope, outside package runtimes, carries these fields.
 */
export async function planOptInCredentialFields(
	ctx: CapabilityContext,
	input: { input: OptInInput; authorityPackageId: string | null | undefined },
): Promise<OptInCredentialPlan> {
	const {
		kind,
		hosts,
		login_exchange: loginExchange,
		provider,
		inject,
		value,
	} = input.input
	const touchesKind =
		kind !== undefined || hosts !== undefined || loginExchange !== undefined
	const touchesFields = provider !== undefined || inject !== undefined
	const hasValue = typeof value === 'string' && value.length > 0
	const none = { setKind: null, fields: null, reportKind: null }
	if (!touchesKind && !touchesFields) {
		// A new value for an existing opt-in kind is still checked against it.
		if (input.input.scope !== 'user' || !hasValue) return none
	} else if (input.input.scope !== 'user' || input.authorityPackageId) {
		throw new McpCallerError(
			'kind, hosts, login_exchange, provider, and inject apply only to user-scope secrets set outside a package.',
		)
	}
	if (touchesKind && !hasValue) {
		throw new McpCallerError(
			'Set kind, hosts, or login_exchange together with a value: whoever supplies the value decides where it may go.',
		)
	}
	const existing = await readStoredCredentialPlacement({
		db: ctx.env.APP_DB,
		orgId: ownerIdFromCaller(ctx.callerContext),
		name: input.input.name,
	})
	if (touchesFields && !hasValue && !existing) {
		throw new McpCallerError(
			`No user-scope secret named "${input.input.name}" to update. Provide a value to create it.`,
		)
	}
	const existingKind: StoredKind = existing?.kind ?? 'secret'
	const effectiveKind = kind ?? existingKind
	let setKind: OptInCredentialPlan['setKind'] = null
	if (isOptInKind(effectiveKind) && hasValue) {
		const effectiveHosts =
			(hosts && normalizeCredentialHosts(hosts)) ??
			(existingKind === effectiveKind && existing ? existing.allowedHosts : [])
		if (effectiveHosts.length === 0) {
			throw new McpCallerError(
				`A ${effectiveKind} credential needs hosts: the hosts it may be sent to.`,
			)
		}
		let effectiveExchange: z.infer<typeof loginExchangeSchema> | null = null
		if (effectiveKind === 'login') {
			effectiveExchange =
				loginExchange ??
				(existingKind === 'login' ? (existing?.loginExchange ?? null) : null)
			if (!effectiveExchange) {
				throw new McpCallerError(
					'A login credential needs login_exchange: how its fields become a session token.',
				)
			}
			assertLoginExchangeOnHosts({
				exchangeUrl: effectiveExchange.url,
				hosts: effectiveHosts,
			})
		} else if (loginExchange !== undefined) {
			throw new McpCallerError('login_exchange applies only to kind "login".')
		}
		assertOptInCredentialValue({
			kind: effectiveKind,
			value: value as string,
			hosts: effectiveHosts,
		})
		setKind = touchesKind
			? {
					kind: effectiveKind,
					hosts: effectiveHosts,
					loginExchange: effectiveExchange,
				}
			: null
	} else {
		if (hosts !== undefined) {
			throw new McpCallerError(
				'hosts apply only to the opt-in kinds (url, login, signing). A Key gets its hosts through host approvals.',
			)
		}
		if (loginExchange !== undefined) {
			throw new McpCallerError('login_exchange applies only to kind "login".')
		}
		if (existingKind !== 'secret' && effectiveKind === 'secret') {
			setKind = { kind: 'secret', hosts: [], loginExchange: null }
		}
	}
	return {
		setKind,
		fields: touchesFields
			? {
					...(provider !== undefined ? { provider } : {}),
					...(inject !== undefined ? { inject } : {}),
				}
			: null,
		reportKind: touchesKind || touchesFields ? effectiveKind : null,
	}
}

/** Applies a validated plan to the secret entry the save just wrote. */
export async function applyOptInCredentialFields(
	ctx: CapabilityContext,
	input: {
		plan: OptInCredentialPlan
		name: string
		saved: ReturnType<typeof toSecretCapabilityOutput>
	},
) {
	const { plan } = input
	if (!plan.setKind && !plan.fields) return input.saved
	const orgId = ownerIdFromCaller(ctx.callerContext)
	const [credentialId] = await findCredentialIdsByLegacyName(
		ctx.env.APP_DB,
		orgId,
		{ type: 'secret', name: input.name },
	)
	if (!credentialId) {
		throw new Error(`Saved secret "${input.name}" has no credential id.`)
	}
	const audit = orgAuditWriterFromRequest(
		ctx.env,
		requireMcpRequest(ctx.callerContext),
	)
	let allowedHosts = input.saved.allowed_hosts
	if (plan.setKind) {
		await setStoredCredentialKind({
			db: ctx.env.APP_DB,
			orgId,
			credentialId,
			kind: plan.setKind.kind,
			hosts: plan.setKind.hosts,
			loginExchange: plan.setKind.loginExchange,
			audit,
		})
		allowedHosts = plan.setKind.hosts
	}
	let fields: { provider: string | null; inject: unknown } | null = null
	if (plan.fields) {
		const updated = await updateCredentialFields({
			db: ctx.env.APP_DB,
			orgId,
			credentialId,
			update: plan.fields,
			audit,
		})
		fields = { provider: updated.provider, inject: updated.inject }
	}
	return {
		...input.saved,
		allowed_hosts: allowedHosts,
		...(plan.reportKind ? { kind: plan.reportKind } : {}),
		...fields,
	}
}
