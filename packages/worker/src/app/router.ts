import { createRouter } from 'remix/router'
import { account } from '#app/handlers/account.ts'
import { createAccountDeleteHandler } from '#app/handlers/account-delete.ts'
import { createAccountProfileApiHandler } from '#app/handlers/account-profile.ts'
import {
	createAccountRemoteConnectorsApiHandler,
	createAccountRemoteConnectorsHandler,
} from '#app/handlers/account-remote-connectors.ts'
import {
	createAccountSecretsApiHandler,
	createAccountSecretsHandler,
} from '#app/handlers/account-secrets.ts'
import { createAuthHandler } from '#app/handlers/auth.ts'
import { createConnectOauthHandler } from '#app/handlers/connect-oauth.ts'
import { createHealthHandler } from '#app/handlers/health.ts'
import { home } from '#app/handlers/home.ts'
import { login } from '#app/handlers/login.ts'
import { logout } from '#app/handlers/logout.ts'
import {
	createPasswordResetConfirmHandler,
	createPasswordResetRequestHandler,
} from '#app/handlers/password-reset.ts'
import { createSessionHandler } from '#app/handlers/session.ts'
import { signup } from '#app/handlers/signup.ts'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { routes } from '#app/routes.ts'
import { type AppEnv } from '#worker/env-schema.ts'

export function createAppRouter(appEnv: AppEnv) {
	const router = createRouter({
		middleware: [],
		async defaultHandler() {
			return render(Layout({}), { status: 404 })
		},
	})

	router.map(routes, {
		actions: {
			home,
			health: createHealthHandler(appEnv),
			login,
			signup,
			account,
			accountDelete: createAccountDeleteHandler(appEnv as unknown as Env),
			accountProfileApi: createAccountProfileApiHandler(
				appEnv as unknown as Env,
			),
			accountProfileApiPost: createAccountProfileApiHandler(
				appEnv as unknown as Env,
			),
			accountRemoteConnectors: createAccountRemoteConnectorsHandler(
				appEnv as unknown as Env,
			),
			accountRemoteConnectorsApi: createAccountRemoteConnectorsApiHandler(
				appEnv as unknown as Env,
			),
			accountRemoteConnectorsApiPost: createAccountRemoteConnectorsApiHandler(
				appEnv as unknown as Env,
			),
			accountSecrets: createAccountSecretsHandler(appEnv as unknown as Env),
			accountSecretNew: createAccountSecretsHandler(appEnv as unknown as Env),
			accountSecretsApprove: createAccountSecretsHandler(
				appEnv as unknown as Env,
			),
			accountSecretDetail: createAccountSecretsHandler(
				appEnv as unknown as Env,
			),
			accountSecretUserDetail: createAccountSecretsHandler(
				appEnv as unknown as Env,
			),
			accountSecretAppDetail: createAccountSecretsHandler(
				appEnv as unknown as Env,
			),
			accountSecretSessionDetail: createAccountSecretsHandler(
				appEnv as unknown as Env,
			),
			accountSecretPackageDetail: createAccountSecretsHandler(
				appEnv as unknown as Env,
			),
			accountSecretsApi: createAccountSecretsApiHandler(
				appEnv as unknown as Env,
			),
			accountSecretsApiPost: createAccountSecretsApiHandler(
				appEnv as unknown as Env,
			),
			connectOauth: createConnectOauthHandler(appEnv as unknown as Env),
			auth: createAuthHandler(appEnv),
			session: createSessionHandler(appEnv as unknown as Env),
			logout,
			passwordResetRequest: createPasswordResetRequestHandler(appEnv),
			passwordResetConfirm: createPasswordResetConfirmHandler(appEnv),
		},
	})

	return router
}
