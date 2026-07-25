import { createRouter } from 'remix/router'
import {
	createAdminHandler,
	createAdminUsersApiHandler,
	createAdminUsersHandler,
	createAdminUserUsageApiHandler,
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
	createAdminFeatureFlagsApiHandler,
	createAdminFeatureFlagsHandler,
} from '#app/handlers/admin-feature-flags.ts'
import {
	createAdminRolesApiHandler,
	createAdminRolesHandler,
} from '#app/handlers/admin-roles.ts'
import {
	createAdminInsightsApiHandler,
	createAdminInsightsHandler,
} from '#app/handlers/admin-insights.ts'
import {
	createAdminPlatformFeedbackApiHandler,
	createAdminPlatformFeedbackHandler,
} from '#app/handlers/admin-platform-feedback.ts'
import {
	createAdminSystemEmailApiHandler,
	createAdminSystemEmailHandler,
} from '#app/handlers/admin-system-email.ts'
import { createAccountHandler } from '#app/handlers/account.ts'
import { createAccountDeleteHandler } from '#app/handlers/account-delete.ts'
import {
	createAccountEmailApiHandler,
	createAccountEmailHandler,
} from '#app/handlers/account-email.ts'
import { createAccountEmailChangeHandler } from '#app/handlers/account-email-change.ts'
import { createAccountExportHandler } from '#app/handlers/account-export.ts'
import {
	createAccountIntegrationsApiHandler,
	createAccountIntegrationsHandler,
} from '#app/handlers/account-integrations.ts'
import {
	createAccountJobsApiHandler,
	createAccountJobsHandler,
} from '#app/handlers/account-jobs.ts'
import {
	createAccountMcpServersApiHandler,
	createAccountMcpServersHandler,
	createAccountMcpServersOauthCallbackHandler,
} from '#app/handlers/account-mcp-servers.ts'
import {
	createAccountMemoriesApiHandler,
	createAccountMemoriesHandler,
} from '#app/handlers/account-memories.ts'
import {
	createAccountPackageInvocationTokensApiHandler,
	createAccountPackageInvocationTokensHandler,
} from '#app/handlers/account-package-invocation-tokens.ts'
import {
	createAccountPackagesApiHandler,
	createAccountPackagesHandler,
} from '#app/handlers/account-packages.ts'
import {
	createAccountPasskeysApiHandler,
	createAccountPasskeysHandler,
} from '#app/handlers/account-passkeys.ts'
import { createAccountConnectionsApiHandler } from '#app/handlers/account-connections.ts'
import { createAccountAvatarApiPostHandler } from '#app/handlers/account-avatar.ts'
import { createAccountProfileApiHandler } from '#app/handlers/account-profile.ts'
import {
	createAccountStarsApiHandler,
	createAccountStarsHandler,
} from '#app/handlers/account-stars.ts'
import {
	createAccountTwoFactorApiHandler,
	createAccountTwoFactorHandler,
} from '#app/handlers/account-two-factor.ts'
import {
	createAccountBillingApiHandler,
	createAccountBillingCheckoutApiHandler,
	createAccountBillingHandler,
	createAccountBillingPortalHandler,
	createAccountBillingSuccessHandler,
} from '#app/handlers/account-billing.ts'
import {
	createAccountUsageApiHandler,
	createAccountUsageHandler,
} from '#app/handlers/account-usage.ts'
import { createAccountResendVerificationHandler } from '#app/handlers/account-resend-verification.ts'
import { createPendingVerificationHandler } from '#app/handlers/pending-verification.ts'
import {
	createAccountRemoteConnectorsApiHandler,
	createAccountRemoteConnectorsHandler,
} from '#app/handlers/account-remote-connectors.ts'
import {
	createAccountSecretsApiHandler,
	createAccountSecretsHandler,
} from '#app/handlers/account-secrets.ts'
import {
	createAccountValuesApiHandler,
	createAccountValuesHandler,
} from '#app/handlers/account-values.ts'
import { createAuthHandler } from '#app/handlers/auth.ts'
import {
	createAuthProviderCallbackHandler,
	createAuthProviderStartHandler,
	createAuthProvidersApiHandler,
} from '#app/handlers/auth-provider.ts'
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
import { createCommunityFeatureApiPostHandler } from '#app/handlers/community-feature.ts'
import { createCommunityIconHandler } from '#app/handlers/community-icon.ts'
import { createCommunityInstallApiPostHandler } from '#app/handlers/community-install.ts'
import { createCommunityTrustApiPostHandler } from '#app/handlers/community-trust.ts'
import {
	createCommunityStarApiPostHandler,
	createCommunityStargazersApiHandler,
} from '#app/handlers/community-star.ts'
import {
	createProfileApiHandler,
	createProfileFollowApiPostHandler,
	createProfileHandler,
	createProfileOgImageHandler,
} from '#app/handlers/profile.tsx'
import { createProfileAvatarHandler } from '#app/handlers/profile-avatar.ts'
import { createWebhookIngressHandler } from '#app/handlers/webhook-ingress.ts'
import { createStripeWebhookHandler } from '#app/handlers/stripe-webhook.ts'
import {
	createTimelineApiHandler,
	createTimelineHandler,
} from '#app/handlers/timeline.tsx'
import {
	createBlogApiHandler,
	createBlogHandler,
	createBlogPostApiHandler,
	createBlogPostHandler,
	createBlogPostOgImageHandler,
	createBlogRssHandler,
} from '#app/handlers/blog.tsx'
import { createHealthHandler } from '#app/handlers/health.ts'
import { createSentryTunnelHandler } from '#app/handlers/sentry-tunnel.ts'
import { createHomeHandler } from '#app/handlers/home.ts'
import { createLoginHandler } from '#app/handlers/login.ts'
import { createOgPageImageHandler } from '#app/handlers/og-page-image.ts'
import {
	createOnboardingApiHandler,
	createOnboardingHandler,
} from '#app/handlers/onboarding.ts'
import { createPrivacyHandler } from '#app/handlers/privacy.ts'
import { createTermsHandler } from '#app/handlers/terms.ts'
import { createResetPasswordHandler } from '#app/handlers/reset-password.ts'
import {
	createTwoFactorVerifyApiHandler,
	createVerifyHandler,
} from '#app/handlers/verify.ts'
import { createVerifyEmailChangeHandler } from '#app/handlers/verify-email-change.ts'
import { createVerifyEmailHandler } from '#app/handlers/verify-email.ts'
import {
	createWebauthnAuthenticationHandler,
	createWebauthnRegistrationHandler,
} from '#app/handlers/webauthn.ts'
import { logout } from '#app/handlers/logout.ts'
import {
	createPasswordResetConfirmHandler,
	createPasswordResetRequestHandler,
} from '#app/handlers/password-reset.ts'
import { createSessionHandler } from '#app/handlers/session.ts'
import { createSignupHandler } from '#app/handlers/signup.ts'
import { createWaitingListHandler } from '#app/handlers/waiting-list.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { routes } from '#app/routes.ts'
import { createAccountWriteLeaseMiddleware } from '#app/account-write-lease-middleware.ts'
export function createAppRouter(env: Env) {
	const router = createRouter({
		middleware: [createAccountWriteLeaseMiddleware(env)],
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
			health: createHealthHandler(env),
			sentryTunnel: createSentryTunnelHandler(env),
			login: createLoginHandler(env),
			ogPageImage: createOgPageImageHandler(env),
			blog: createBlogHandler(env),
			blogApi: createBlogApiHandler(env),
			blogRss: createBlogRssHandler(env),
			blogPost: createBlogPostHandler(env),
			blogPostApi: createBlogPostApiHandler(env),
			blogPostOgImage: createBlogPostOgImageHandler(env),
			privacy: createPrivacyHandler(env),
			terms: createTermsHandler(env),
			onboarding: createOnboardingHandler(env),
			onboardingApi: createOnboardingApiHandler(env),
			resetPassword: createResetPasswordHandler(env),
			verifyEmail: createVerifyEmailHandler(env),
			verifyEmailChange: createVerifyEmailChangeHandler(env),
			pendingVerification: createPendingVerificationHandler(env),
			signup: createSignupHandler(env),
			waitingList: createWaitingListHandler(env),
			account: createAccountHandler(env),
			accountDelete: createAccountDeleteHandler(env),
			accountExport: createAccountExportHandler(env),
			accountIntegrations: createAccountIntegrationsHandler(env),
			accountIntegrationDetail: createAccountIntegrationsHandler(env),
			accountIntegrationsApi: createAccountIntegrationsApiHandler(env),
			accountMcpServers: createAccountMcpServersHandler(env),
			accountMcpServerNew: createAccountMcpServersHandler(env),
			accountMcpServerDetail: createAccountMcpServersHandler(env),
			accountMcpServersOauthCallback:
				createAccountMcpServersOauthCallbackHandler(env),
			accountMcpServersApi: createAccountMcpServersApiHandler(env),
			accountMcpServersApiPost: createAccountMcpServersApiHandler(env),
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
			accountPackages: createAccountPackagesHandler(env),
			accountPackageDetail: createAccountPackagesHandler(env),
			accountPackagesApi: createAccountPackagesApiHandler(env),
			accountConnectionsApi: createAccountConnectionsApiHandler(env),
			accountConnectionsApiPost: createAccountConnectionsApiHandler(env),
			accountPasskeys: createAccountPasskeysHandler(env),
			accountPasskeysApi: createAccountPasskeysApiHandler(env),
			accountPasskeysApiPost: createAccountPasskeysApiHandler(env),
			accountProfileApi: createAccountProfileApiHandler(env),
			accountProfileApiPost: createAccountProfileApiHandler(env),
			accountAvatarApiPost: createAccountAvatarApiPostHandler(env),
			accountStars: createAccountStarsHandler(env),
			accountStarsApi: createAccountStarsApiHandler(env),
			accountTwoFactor: createAccountTwoFactorHandler(env),
			accountTwoFactorApi: createAccountTwoFactorApiHandler(env),
			accountTwoFactorApiPost: createAccountTwoFactorApiHandler(env),
			accountBilling: createAccountBillingHandler(env),
			accountBillingApi: createAccountBillingApiHandler(env),
			accountBillingCheckoutPost: createAccountBillingCheckoutApiHandler(env),
			accountBillingSuccess: createAccountBillingSuccessHandler(env),
			accountBillingPortal: createAccountBillingPortalHandler(env),
			accountUsage: createAccountUsageHandler(env),
			accountUsageApi: createAccountUsageApiHandler(env),
			accountEmailChange: createAccountEmailChangeHandler(env),
			accountResendVerification: createAccountResendVerificationHandler(env),
			accountRemoteConnectors: createAccountRemoteConnectorsHandler(env),
			accountRemoteConnectorNew: createAccountRemoteConnectorsHandler(env),
			accountRemoteConnectorDetail: createAccountRemoteConnectorsHandler(env),
			accountRemoteConnectorsApi: createAccountRemoteConnectorsApiHandler(env),
			accountRemoteConnectorsApiPost:
				createAccountRemoteConnectorsApiHandler(env),
			accountSecrets: createAccountSecretsHandler(env),
			accountSecretNew: createAccountSecretsHandler(env),
			accountSecretsApprove: createAccountSecretsHandler(env),
			accountSecretUserDetail: createAccountSecretsHandler(env),
			accountSecretSessionDetail: createAccountSecretsHandler(env),
			accountSecretPackageDetail: createAccountSecretsHandler(env),
			accountSecretsApi: createAccountSecretsApiHandler(env),
			accountSecretsApiPost: createAccountSecretsApiHandler(env),
			accountValues: createAccountValuesHandler(env),
			accountValueNew: createAccountValuesHandler(env),
			accountValueDetail: createAccountValuesHandler(env),
			accountValuesApi: createAccountValuesApiHandler(env),
			accountValuesApiPost: createAccountValuesApiHandler(env),
			accountJobs: createAccountJobsHandler(env),
			accountJobDetail: createAccountJobsHandler(env),
			accountJobsApi: createAccountJobsApiHandler(env),
			accountJobsApiPost: createAccountJobsApiHandler(env),
			accountMemories: createAccountMemoriesHandler(env),
			accountMemoryDetail: createAccountMemoriesHandler(env),
			accountMemoriesApi: createAccountMemoriesApiHandler(env),
			accountMemoriesApiPost: createAccountMemoriesApiHandler(env),
			accountEmail: createAccountEmailHandler(env),
			accountEmailDetail: createAccountEmailHandler(env),
			accountEmailApi: createAccountEmailApiHandler(env),
			admin: createAdminHandler(env),
			adminUsers: createAdminUsersHandler(env),
			adminUserDetail: createAdminUsersHandler(env),
			adminUsersApi: createAdminUsersApiHandler(env),
			adminUsersApiPost: createAdminUsersApiHandler(env),
			adminInvites: createAdminInvitesHandler(env),
			adminInvitesApi: createAdminInvitesApiHandler(env),
			adminInvitesApiPost: createAdminInvitesApiHandler(env),
			adminFeatureFlags: createAdminFeatureFlagsHandler(env),
			adminFeatureFlagsApi: createAdminFeatureFlagsApiHandler(env),
			adminFeatureFlagsApiPost: createAdminFeatureFlagsApiHandler(env),
			adminRoles: createAdminRolesHandler(env),
			adminRolesApi: createAdminRolesApiHandler(env),
			adminCommunityReports: createAdminCommunityReportsHandler(env),
			adminCommunityReportsApi: createAdminCommunityReportsApiHandler(env),
			adminCommunityReportsApiPost: createAdminCommunityReportsApiHandler(env),
			adminUserUsageApi: createAdminUserUsageApiHandler(env),
			adminInsights: createAdminInsightsHandler(env),
			adminInsightsApi: createAdminInsightsApiHandler(env),
			adminPlatformFeedback: createAdminPlatformFeedbackHandler(env),
			adminPlatformFeedbackApi: createAdminPlatformFeedbackApiHandler(env),
			adminSystemEmail: createAdminSystemEmailHandler(env),
			adminSystemEmailApi: createAdminSystemEmailApiHandler(env),
			community: createCommunityHandler(env),
			communityApi: createCommunityApiHandler(env),
			communityDetail: createCommunityDetailHandler(env),
			communityDetailApi: createCommunityDetailApiHandler(env),
			communityDetailIcon: createCommunityIconHandler(env),
			communityDetailOgImage: createCommunityDetailOgImageHandler(env),
			communityReportApiPost: createCommunityReportApiPostHandler(env),
			communityTrustApiPost: createCommunityTrustApiPostHandler(env),
			communityFeatureApiPost: createCommunityFeatureApiPostHandler(env),
			communityInstallApiPost: createCommunityInstallApiPostHandler(env),
			communityStarApiPost: createCommunityStarApiPostHandler(env),
			communityStargazersApi: createCommunityStargazersApiHandler(env),
			profile: createProfileHandler(env),
			profileApi: createProfileApiHandler(env),
			profileAvatar: createProfileAvatarHandler(env),
			profileOgImage: createProfileOgImageHandler(env),
			profileFollowApiPost: createProfileFollowApiPostHandler(env),
			webhookIngress: createWebhookIngressHandler(env),
			stripeWebhook: createStripeWebhookHandler(env),
			timeline: createTimelineHandler(env),
			timelineApi: createTimelineApiHandler(env),
			connectOauth: createConnectOauthHandler(env),
			auth: createAuthHandler(env),
			authProvidersApi: createAuthProvidersApiHandler(env),
			authProviderStart: createAuthProviderStartHandler(env),
			authProviderCallback: createAuthProviderCallbackHandler(env),
			session: createSessionHandler(env),
			logout,
			passwordResetRequest: createPasswordResetRequestHandler(env),
			passwordResetConfirm: createPasswordResetConfirmHandler(env),
			verify: createVerifyHandler(env),
			verifyTwoFactorApi: createTwoFactorVerifyApiHandler(env),
			webauthnRegistration: createWebauthnRegistrationHandler(env),
			webauthnRegistrationPost: createWebauthnRegistrationHandler(env),
			webauthnAuthentication: createWebauthnAuthenticationHandler(env),
			webauthnAuthenticationPost: createWebauthnAuthenticationHandler(env),
		},
	})

	return router
}
