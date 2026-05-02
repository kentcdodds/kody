import { createRouter } from 'remix/fetch-router'
import { account } from '#app/handlers/account.ts'
import {
	createAccountSecretsApiHandler,
	createAccountSecretsHandler,
} from '#app/handlers/account-secrets.ts'
import { createAuthHandler } from '#app/handlers/auth.ts'
import { chat } from '#app/handlers/chat.ts'
import { createConnectOauthHandler } from '#app/handlers/connect-oauth.ts'
import {
	createChatThreadsHandler,
	createDeleteChatThreadHandler,
	createUpdateChatThreadHandler,
} from '#app/handlers/chat-threads.ts'
import { createHealthHandler } from '#app/handlers/health.ts'
import { home } from '#app/handlers/home.ts'
import { login } from '#app/handlers/login.ts'
import { logout } from '#app/handlers/logout.ts'
import {
	createPasswordResetConfirmHandler,
	createPasswordResetRequestHandler,
} from '#app/handlers/password-reset.ts'
import {
	createConnectSecretApiHandler,
	createConnectSecretHandler,
} from '#app/handlers/connect-secret.ts'
import { session } from '#app/handlers/session.ts'
import { signup } from '#app/handlers/signup.ts'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { routes } from '#app/routes.ts'
import { type AppEnv } from '#worker/env-schema.ts'

export function createAppRouter(appEnv: AppEnv) {
	const router = createRouter({
		middleware: [],
		async defaultHandler() {
			return render(Layout({}))
		},
	})
	const chatThreadsHandler = createChatThreadsHandler(appEnv)

	router.map(routes, {
		actions: {
			home,
			chat,
			chatThread: chat,
			chatThreads: chatThreadsHandler,
			chatThreadsCreate: chatThreadsHandler,
			chatThreadsUpdate: createUpdateChatThreadHandler(appEnv),
			chatThreadsDelete: createDeleteChatThreadHandler(appEnv),
			health: createHealthHandler(appEnv),
			login,
			signup,
			account,
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
			connectSecret: createConnectSecretHandler(appEnv as unknown as Env),
			connectSecretApi: createConnectSecretApiHandler(appEnv as unknown as Env),
			connectSecretApiPost: createConnectSecretApiHandler(
				appEnv as unknown as Env,
			),
			connectOauth: createConnectOauthHandler(appEnv as unknown as Env),
			auth: createAuthHandler(appEnv),
			session,
			logout,
			passwordResetRequest: createPasswordResetRequestHandler(appEnv),
			passwordResetConfirm: createPasswordResetConfirmHandler(appEnv),
		},
	})

	return router
}
