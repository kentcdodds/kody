import { type AccountIntegrationsLoaderData } from '#app/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	getJoinedIntegration,
	listJoinedIntegrations,
	toIntegrationConfig,
	type IntegrationConfig,
} from '#worker/integrations/service.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export type AccountIntegrationRecord = IntegrationConfig & {
	appSlug: string
	provider: string
	appLabel: string | null
	accountLabel: string | null
	createdAt: string
	updatedAt: string
}

function toAccountIntegrationRecord(input: {
	app: Parameters<typeof toIntegrationConfig>[0]
	connection: Parameters<typeof toIntegrationConfig>[1]
}): AccountIntegrationRecord {
	const config = toIntegrationConfig(input.app, input.connection)
	return {
		...config,
		appSlug: input.app.slug,
		provider: input.app.provider,
		appLabel: input.app.label,
		accountLabel: input.connection.accountLabel,
		createdAt: input.connection.createdAt,
		updatedAt: input.connection.updatedAt,
	}
}

export async function loadAccountIntegrationsData(
	env: Env,
	user: AuthenticatedUser,
): Promise<AccountIntegrationsLoaderData> {
	const joined = await listJoinedIntegrations({
		env,
		userId: user.mcpUser.userId,
	})
	const integrations = joined
		.map((entry) => toAccountIntegrationRecord(entry))
		.sort((left, right) => {
			const appCompare = left.appSlug.localeCompare(right.appSlug)
			if (appCompare !== 0) return appCompare
			return left.name.localeCompare(right.name)
		})

	return {
		ok: true,
		email: user.email,
		username: user.username,
		integrations,
	}
}

export async function loadAccountIntegrationByName(
	env: Env,
	user: AuthenticatedUser,
	name: string,
): Promise<AccountIntegrationRecord | null> {
	const joined = await getJoinedIntegration({
		env,
		userId: user.mcpUser.userId,
		name,
	})
	if (!joined) return null
	return toAccountIntegrationRecord(joined)
}
