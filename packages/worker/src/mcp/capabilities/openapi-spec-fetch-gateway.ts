import { type OpenApiSpecFetchGateway } from '#worker/openapi/fetch-spec.ts'
import { type CapabilityContext } from './types.ts'

/**
 * Gateway wiring every capability that fetches a user-supplied OpenAPI spec
 * URL shares, so spec fetches meter and consume quota like any other
 * outbound request.
 */
export function openApiSpecFetchGatewayFor(
	ctx: CapabilityContext,
): OpenApiSpecFetchGateway {
	return {
		env: ctx.env,
		props: {
			baseUrl: ctx.callerContext.baseUrl,
			userId: ctx.callerContext.user?.userId ?? null,
			email: ctx.callerContext.user?.email ?? null,
			storageContext: {
				sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
				appId: ctx.callerContext.storageContext?.appId ?? null,
				packageId: ctx.callerContext.storageContext?.packageId ?? null,
				storageId: ctx.callerContext.storageContext?.storageId ?? null,
			},
		},
		waitUntil: ctx.waitUntil,
	}
}
