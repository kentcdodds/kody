import { type Action } from 'remix/router'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'
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

type AccountIntegrationsPayload = {
	ok: true
	email: string
	username: string
	integrations: Array<AccountIntegrationListItem>
}

export function createAccountIntegrationsHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const { session, setCookie } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const response = render(Layout({ title: 'Integrations' }))
			if (setCookie) {
				response.headers.set('Set-Cookie', setCookie)
			}
			return response
		},
	} satisfies Action<typeof routes.accountIntegrations>
}

export function createAccountIntegrationsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			return jsonResponse(await buildPayload({ env, user }))
		},
	} satisfies Action<typeof routes.accountIntegrationsApi>
}

async function buildPayload(input: {
	env: Env
	user: AuthenticatedUser
}): Promise<AccountIntegrationsPayload> {
	const values = await listValues({
		env: input.env,
		userId: input.user.mcpUser.userId,
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
		email: input.user.email,
		username: input.user.username,
		integrations,
	}
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
		},
	})
}
