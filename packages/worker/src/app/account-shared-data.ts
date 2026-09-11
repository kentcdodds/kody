import { type AccountSharedLoaderData } from '#universal/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	hydratePackageShareGrantViews,
	listInboundPackageShareGrants,
	listOutboundPackageShareGrants,
	toPackageShareGrantLoaderView,
} from '#worker/package-registry/share-grants.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function loadAccountSharedData(input: {
	env: Env
	user: AuthenticatedUser
}): Promise<AccountSharedLoaderData> {
	const userId = input.user.mcpUser.userId
	const [outboundRows, inboundRows] = await Promise.all([
		listOutboundPackageShareGrants(input.env.APP_DB, userId),
		listInboundPackageShareGrants(input.env.APP_DB, {
			userId,
			email: input.user.email,
			emailVerified: input.user.emailVerified,
		}),
	])
	const [outbound, inbound] = await Promise.all([
		hydratePackageShareGrantViews(input.env.APP_DB, outboundRows),
		hydratePackageShareGrantViews(input.env.APP_DB, inboundRows),
	])
	return {
		ok: true,
		outbound: outbound.map(toPackageShareGrantLoaderView),
		inbound: inbound.map(toPackageShareGrantLoaderView),
	}
}
