/**
 * A package's credential needs as an agent reads them in `packageGet`
 * (ADR 0068): the published closure, each need with how it resolves for the
 * caller. Options are filtered by the caller's Use and never carry values.
 */
import * as Sentry from '@sentry/cloudflare'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	listUsableCredentials,
	resolveNeedCandidates,
} from './credential-candidates.ts'
import { loadPublishedCredentialNeeds } from './credential-needs-closure.ts'

export async function describePackageCredentialNeeds(input: {
	env: Env
	request: RequestContext
	ownerUserId: string
	sourceId: string
}) {
	try {
		const needs = await loadPublishedCredentialNeeds({
			env: input.env,
			userId: input.ownerUserId,
			sourceId: input.sourceId,
		})
		if (needs.length === 0) return []
		const usable = await listUsableCredentials({
			env: input.env,
			request: input.request,
		})
		return needs.map((need) => {
			const resolution = resolveNeedCandidates(need, usable)
			return {
				...need,
				status: resolution.status,
				autoPick: resolution.autoPick?.name ?? null,
				yourOptions: resolution.options.map((option) => ({
					name: option.name,
					scope: option.scope,
					...(option.scope === 'org' && input.request.org.slug
						? { org: input.request.org.slug }
						: {}),
					hosts: option.hosts,
				})),
			}
		})
	} catch (error) {
		// packageGet keeps working when needs cannot be read.
		Sentry.captureException(error, {
			tags: { scope: 'packages.get.credential-needs' },
			extra: { sourceId: input.sourceId },
		})
		return []
	}
}
