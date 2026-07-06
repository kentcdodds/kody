import { createRouter } from 'remix/router'
import {
	createAdminHandler,
	createAdminUsersApiHandler,
	createAdminUsersHandler,
} from '#app/handlers/admin-users.ts'
import {
	createAdminCommunityReportsApiHandler,
	createAdminCommunityReportsHandler,
} from '#app/handlers/admin-community-reports.ts'
import {
	createAdminInvitesApiHandler,
	createAdminInvitesHandler,
} from '#app/handlers/admin-invites.ts'
import {
	createAdminRolesApiHandler,
	createAdminRolesHandler,
} from '#app/handlers/admin-roles.ts'
import {
	createAdminUsageApiHandler,
	createAdminUsageHandler,
} from '#app/handlers/admin-usage.ts'
import {
	createAdminSystemEmailApiHandler,
	createAdminSystemEmailHandler,
} from '#app/handlers/admin-system-email.ts'
import { createAccountHandler } from '#app/handlers/account.ts'
import { createAccountDeleteHandler } from '#app/handlers/account-delete.ts'
import { createAccountExportHandler } from '#app/handlers/account-export.ts'
import {
	createAccountIntegrationsApiHandler,
	createAccountIntegrationsHandler,
} from '#app/handlers/account-integrations.ts'
import {
	createAccountPackageInvocationTokensApiHandler,
	createAccountPackageInvocationTokensHandler,
} from '#app/handlers/account-package-invocation-tokens.ts'
import { createAccountProfileApiHandler } from '#app/handlers/account-profile.ts'
import { createAccountResendVerificationHandler } from '#app/handlers/account-resend-verification.ts'
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
import {
	createCommunityApiHandler,
	createCommunityHandler,
} from '#app/handlers/community.tsx'
import {
	createCommunityDetailApiHandler,
	createCommunityDetailHandler,
	createCommunityDetailOgImageHandler,
	createCommunityReportApiPostHandler,
} from '#app/handlers/community-detail.tsx'
import { createHealthHandler } from '#app/handlers/health.ts'
import { createHomeHandler } from '#app/handlers/home.ts'
import { createLoginHandler } from '#app/handlers/login.ts'
import { createPrivacyHandler } from '#app/handlers/privacy.ts'
import { createResetPasswordHandler } from '#app/handlers/reset-password.ts'
import { createVerifyEmailHandler } from '#app/handlers/verify-email.ts'
import { logout } from '#app/handlers/logout.ts'
import {
	createPasswordResetConfirmHandler,
	createPasswordResetRequestHandler,
} from '#app/handlers/password-reset.ts'
import { createSessionHandler } from '#app/handlers/session.ts'
import { createSignupHandler } from '#app/handlers/signup.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { routes } from '#app/routes.ts'
import { type AppEnv } from '#worker/env-schema.ts'

export function createAppRouter(appEnv: AppEnv) {
	const env = appEnv as unknown as Env

	const router = createRouter({
		middleware: [],
		async defaultHandler({ request }) {
			return renderAppPage({
				request,
				env,
				title: 'Not found',
				notFound: true,
				status: 404,
			})
		},
	})

	router.map(routes, {
		actions: {
			home: createHomeHandler(env),
			health: createHealthHandler(appEnv),
			login: createLoginHandler(env),
			privacy: createPrivacyHandler(env),
			resetPassword: createResetPasswordHandler(env),
			verifyEmail: createVerifyEmailHandler(env),
			signup: createSignupHandler(env),
			account: createAccountHandler(env),
			accountDelete: createAccountDeleteHandler(env),
			accountExport: createAccountExportHandler(env),
			accountIntegrations: createAccountIntegrationsHandler(env),
			accountIntegrationsApi: createAccountIntegrationsApiHandler(env),
			accountPackageInvocationTokens:
				createAccountPackageInvocationTokensHandler(env),
			accountPackageInvocationTokenNew:
				createAccountPackageInvocationTokensHandler(env),
			accountPackageInvocationTokenDetail:
				createAccountPackageInvocationTokensHandler(env),
			accountPackageInvocationTokensApi:
				createAccountPackageInvocationTokensApiHandler(env),
			accountPackageInvocationTokensApiPost:
				createAccountPackageInvocationTokensApiHandler(env),
			accountProfileApi: createAccountProfileApiHandler(env),
			accountProfileApiPost: createAccountProfileApiHandler(env),
			accountResendVerification: createAccountResendVerificationHandler(appEnv),
			accountRemoteConnectors: createAccountRemoteConnectorsHandler(env),
			accountRemoteConnectorsApi: createAccountRemoteConnectorsApiHandler(env),
			accountRemoteConnectorsApiPost:
				createAccountRemoteConnectorsApiHandler(env),
			accountSecrets: createAccountSecretsHandler(env),
			accountSecretNew: createAccountSecretsHandler(env),
			accountSecretsApprove: createAccountSecretsHandler(env),
			accountSecretDetail: createAccountSecretsHandler(env),
			accountSecretUserDetail: createAccountSecretsHandler(env),
			accountSecretAppDetail: createAccountSecretsHandler(env),
			accountSecretSessionDetail: createAccountSecretsHandler(env),
			accountSecretPackageDetail: createAccountSecretsHandler(env),
			accountSecretsApi: createAccountSecretsApiHandler(env),
			accountSecretsApiPost: createAccountSecretsApiHandler(env),
			admin: createAdminHandler(env),
			adminUsers: createAdminUsersHandler(env),
			adminUsersApi: createAdminUsersApiHandler(env),
			adminUsersApiPost: createAdminUsersApiHandler(env),
			adminInvites: createAdminInvitesHandler(env),
			adminInvitesApi: createAdminInvitesApiHandler(env),
			adminInvitesApiPost: createAdminInvitesApiHandler(env),
			adminRoles: createAdminRolesHandler(env),
			adminRolesApi: createAdminRolesApiHandler(env),
			adminCommunityReports: createAdminCommunityReportsHandler(env),
			adminCommunityReportsApi: createAdminCommunityReportsApiHandler(env),
			adminCommunityReportsApiPost: createAdminCommunityReportsApiHandler(env),
			adminUsage: createAdminUsageHandler(env),
			adminUsageApi: createAdminUsageApiHandler(env),
			adminSystemEmail: createAdminSystemEmailHandler(env),
			adminSystemEmailApi: createAdminSystemEmailApiHandler(env),
			community: createCommunityHandler(env),
			communityApi: createCommunityApiHandler(env),
			communityDetail: createCommunityDetailHandler(env),
			communityDetailApi: createCommunityDetailApiHandler(env),
			communityDetailOgImage: createCommunityDetailOgImageHandler(env),
			communityReportApiPost: createCommunityReportApiPostHandler(env),
			connectOauth: createConnectOauthHandler(env),
			auth: createAuthHandler(appEnv),
			session: createSessionHandler(env),
			logout,
			passwordResetRequest: createPasswordResetRequestHandler(appEnv),
			passwordResetConfirm: createPasswordResetConfirmHandler(appEnv),
		},
	})

	return router
}
