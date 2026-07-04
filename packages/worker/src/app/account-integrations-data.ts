import { type AccountIntegrationsLoaderData } from '#app/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	type IntegrationConfig,
	parseIntegrationConfig,
	parseIntegrationJson,
	parseIntegrationValueName,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { listValues } from '#mcp/values/service.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

type AccountIntegrationListItem = IntegrationConfig & {
	valueName: string
	createdAt: string
	updatedAt: string
}

export async function loadAccountIntegrationsData(
	env: Env,
	user: AuthenticatedUser,
): Promise<AccountIntegrationsLoaderData> {
	const values = await listValues({
		env,
		userId: user.mcpUser.userId,
		scope: 'user',
		storageContext: { sessionId: null, appId: null },
	})
	const integrations = values
		.map((value) => {
			const integrationName = parseIntegrationValueName(value.name)
			if (!integrationName) return null
			const config = parseIntegrationConfig(
				parseIntegrationJson(value.value),
				integrationName,
			)
			if (!config) return null
			return {
				...config,
				valueName: value.name,
				createdAt: value.createdAt,
				updatedAt: value.updatedAt,
			}
		})
		.filter((entry): entry is AccountIntegrationListItem => Boolean(entry))
		.sort((left, right) => left.name.localeCompare(right.name))

	return {
		ok: true,
		email: user.email,
		username: user.username,
		integrations,
	}
}
