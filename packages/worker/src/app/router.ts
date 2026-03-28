import { createRouter } from 'remix/fetch-router'
import { account } from '#app/handlers/account.ts'
import {
	createAccountSecretsApiHandler,
	createAccountSecretsHandler,
} from '#app/handlers/account-secrets.ts'
import {
	createConnectSecretApiHandler,
	createConnectSecretHandler,
} from '#app/handlers/connect-secret.ts'
import { createAuthHandler } from '#app/handlers/auth.ts'
import { chat } from '#app/handlers/chat.ts'
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
import { createSavedUiPageHandler } from '#app/handlers/saved-ui.ts'
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

	router.map(routes.home, home)
	router.map(routes.chat, chat)
	router.map(routes.chatThread, chat)
	router.map(routes.chatThreads, chatThreadsHandler)
	router.map(routes.chatThreadsCreate, chatThreadsHandler)
	router.map(routes.chatThreadsUpdate, createUpdateChatThreadHandler(appEnv))
	router.map(routes.chatThreadsDelete, createDeleteChatThreadHandler(appEnv))
	router.map(routes.health, createHealthHandler(appEnv))
	router.map(routes.login, login)
	router.map(routes.signup, signup)
	router.map(routes.account, account)
	router.map(routes.accountSecrets, createAccountSecretsHandler(appEnv as Env))
	router.map(
		routes.accountSecretNew,
		createAccountSecretsHandler(appEnv as Env),
	)
	router.map(
		routes.accountSecretsApprove,
		createAccountSecretsHandler(appEnv as Env),
	)
	router.map(
		routes.accountSecretDetail,
		createAccountSecretsHandler(appEnv as Env),
	)
	router.map(
		routes.accountSecretUserDetail,
		createAccountSecretsHandler(appEnv as Env),
	)
	router.map(
		routes.accountSecretAppDetail,
		createAccountSecretsHandler(appEnv as Env),
	)
	router.map(
		routes.accountSecretSessionDetail,
		createAccountSecretsHandler(appEnv as Env),
	)
	router.map(
		routes.accountSecretsApi,
		createAccountSecretsApiHandler(appEnv as Env),
	)
	router.map(
		routes.accountSecretsApiPost,
		createAccountSecretsApiHandler(appEnv as Env),
	)
	router.map(routes.connectSecret, createConnectSecretHandler(appEnv as Env))
	router.map(
		routes.connectSecretApi,
		createConnectSecretApiHandler(appEnv as Env),
	)
	router.map(routes.savedUi, createSavedUiPageHandler(appEnv as Env))
	router.map(routes.auth, createAuthHandler(appEnv))
	router.map(routes.session, session)
	router.map(routes.logout, logout)
	router.map(
		routes.passwordResetRequest,
		createPasswordResetRequestHandler(appEnv),
	)
	router.map(
		routes.passwordResetConfirm,
		createPasswordResetConfirmHandler(appEnv),
	)

	return router
}
