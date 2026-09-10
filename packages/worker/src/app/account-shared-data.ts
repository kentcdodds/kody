import { type AccountSharedLoaderData } from '#universal/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	hydratePackageShareGrantView,
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
		}),
	])
	const [outbound, inbound] = await Promise.all([
		Promise.all(
			outboundRows.map((grant) =>
				hydratePackageShareGrantView({ db: input.env.APP_DB, grant }),
			),
		),
		Promise.all(
			inboundRows.map((grant) =>
				hydratePackageShareGrantView({ db: input.env.APP_DB, grant }),
			),
		),
	])
	return {
		ok: true,
		outbound: outbound.map(toPackageShareGrantLoaderView),
		inbound: inbound.map(toPackageShareGrantLoaderView),
	}
}
