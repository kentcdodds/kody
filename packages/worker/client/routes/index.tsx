import { type RouteLoader } from '#client/client-router.tsx'
import { oauthPaths } from '#app/oauth-paths.ts'
import { routePattern } from '#app/route-pattern.ts'
import { routes } from '#app/routes.ts'
import { AccountRoute, accountRouteLoader } from './account.tsx'
import {
	AccountBillingRoute,
	accountBillingRouteLoader,
} from './account-billing.tsx'
import { AccountEmailRoute, accountEmailRouteLoader } from './account-email.tsx'
import { AccountUsageRoute, accountUsageRouteLoader } from './account-usage.tsx'
import {
	AccountIntegrationsRoute,
	accountIntegrationsRouteLoader,
} from './account-integrations.tsx'
import { AccountJobsRoute, accountJobsRouteLoader } from './account-jobs.tsx'
import {
	AccountMcpServersRoute,
	accountMcpServersRouteLoader,
} from './account-mcp-servers.tsx'
import {
	AccountMemoriesRoute,
	accountMemoriesRouteLoader,
} from './account-memories.tsx'
import {
	AccountPackageInvocationTokensRoute,
	accountPackageInvocationTokensRouteLoader,
} from './account-package-invocation-tokens.tsx'
import {
	AccountPackagesRoute,
	accountPackagesRouteLoader,
} from './account-packages.tsx'
import { AccountStarsRoute, accountStarsRouteLoader } from './account-stars.tsx'
import {
	AccountPasskeysRoute,
	accountPasskeysRouteLoader,
} from './account-passkeys.tsx'
import {
	AccountRemoteConnectorsRoute,
	accountRemoteConnectorsRouteLoader,
} from './account-remote-connectors.tsx'
import {
	AccountSecretsRoute,
	accountSecretsRouteLoader,
} from './account-secrets.tsx'
import {
	AccountTwoFactorRoute,
	accountTwoFactorRouteLoader,
} from './account-two-factor.tsx'
import {
	AccountValuesRoute,
	accountValuesRouteLoader,
} from './account-values.tsx'
import {
	AdminCommunityReportsRoute,
	adminCommunityReportsRouteLoader,
} from './admin-community-reports.tsx'
import {
	AdminInsightsRoute,
	adminInsightsRouteLoader,
} from './admin-insights.tsx'
import { AdminInvitesRoute, adminInvitesRouteLoader } from './admin-invites.tsx'
import {
	AdminFeatureFlagsRoute,
	adminFeatureFlagsRouteLoader,
} from './admin-feature-flags.tsx'
import {
	AdminPlatformFeedbackRoute,
	adminPlatformFeedbackRouteLoader,
} from './admin-platform-feedback.tsx'
import { AdminRolesRoute, adminRolesRouteLoader } from './admin-roles.tsx'
import {
	AdminSystemEmailRoute,
	adminSystemEmailRouteLoader,
} from './admin-system-email.tsx'
import { AdminUsersRoute, adminUsersRouteLoader } from './admin-users.tsx'
import { BlogRoute, blogRouteLoader } from './blog.tsx'
import { BlogPostRoute, blogPostRouteLoader } from './blog-post.tsx'
import {
	CommunityDetailRoute,
	communityDetailRouteLoader,
} from './community-detail.tsx'
import { CommunityRoute, communityRouteLoader } from './community.tsx'
import { ConnectOauthRoute } from './connect-oauth.tsx'
import { HomeRoute, homeRouteLoader } from './home.tsx'
import { LoginRoute, authProvidersRouteLoader } from './login.tsx'
import { OnboardingRoute, onboardingRouteLoader } from './onboarding.tsx'
import { ProfileRoute, profileRouteLoader } from './profile.tsx'
import { TimelineRoute, timelineRouteLoader } from './timeline.tsx'
import {
	PendingVerificationRoute,
	pendingVerificationRouteLoader,
} from './pending-verification.tsx'
import { PrivacyRoute } from './privacy.tsx'
import { TermsRoute } from './terms.tsx'
import {
	OAuthAuthorizeRoute,
	oauthAuthorizeRouteLoader,
} from './oauth-authorize.tsx'
import { OAuthCallbackRoute } from './oauth-callback.tsx'
import { ResetPasswordRoute } from './reset-password.tsx'
import { VerifyEmailRoute } from './verify-email.tsx'
import { VerifyRoute } from './verify.tsx'

export const clientRouteLoaders: Record<string, RouteLoader> = {
	[routePattern(routes.home)]: homeRouteLoader,
	[routePattern(routes.account)]: accountRouteLoader,
	[routePattern(routes.accountBilling)]: accountBillingRouteLoader,
	[routePattern(routes.accountUsage)]: accountUsageRouteLoader,
	[routePattern(routes.accountIntegrations)]: accountIntegrationsRouteLoader,
	[routePattern(routes.accountIntegrationDetail)]:
		accountIntegrationsRouteLoader,
	[routePattern(routes.accountMcpServers)]: accountMcpServersRouteLoader,
	[routePattern(routes.accountMcpServerNew)]: accountMcpServersRouteLoader,
	[routePattern(routes.accountMcpServerDetail)]: accountMcpServersRouteLoader,
	[routePattern(routes.accountPackageInvocationTokens)]:
		accountPackageInvocationTokensRouteLoader,
	[routePattern(routes.accountPackageInvocationTokenNew)]:
		accountPackageInvocationTokensRouteLoader,
	[routePattern(routes.accountPackageInvocationTokenDetail)]:
		accountPackageInvocationTokensRouteLoader,
	[routePattern(routes.accountPackages)]: accountPackagesRouteLoader,
	[routePattern(routes.accountPackageDetail)]: accountPackagesRouteLoader,
	[routePattern(routes.accountStars)]: accountStarsRouteLoader,
	[routePattern(routes.accountPasskeys)]: accountPasskeysRouteLoader,
	[routePattern(routes.accountRemoteConnectors)]:
		accountRemoteConnectorsRouteLoader,
	[routePattern(routes.accountRemoteConnectorNew)]:
		accountRemoteConnectorsRouteLoader,
	[routePattern(routes.accountRemoteConnectorDetail)]:
		accountRemoteConnectorsRouteLoader,
	[routePattern(routes.accountSecrets)]: accountSecretsRouteLoader,
	[routePattern(routes.accountSecretNew)]: accountSecretsRouteLoader,
	[routePattern(routes.accountSecretsApprove)]: accountSecretsRouteLoader,
	[routePattern(routes.accountSecretUserDetail)]: accountSecretsRouteLoader,
	[routePattern(routes.accountSecretPackageDetail)]: accountSecretsRouteLoader,
	[routePattern(routes.accountSecretSessionDetail)]: accountSecretsRouteLoader,
	[routePattern(routes.accountValues)]: accountValuesRouteLoader,
	[routePattern(routes.accountValueNew)]: accountValuesRouteLoader,
	[routePattern(routes.accountValueDetail)]: accountValuesRouteLoader,
	[routePattern(routes.accountJobs)]: accountJobsRouteLoader,
	[routePattern(routes.accountJobDetail)]: accountJobsRouteLoader,
	[routePattern(routes.accountMemories)]: accountMemoriesRouteLoader,
	[routePattern(routes.accountMemoryDetail)]: accountMemoriesRouteLoader,
	[routePattern(routes.accountEmail)]: accountEmailRouteLoader,
	[routePattern(routes.accountEmailDetail)]: accountEmailRouteLoader,
	[routePattern(routes.accountTwoFactor)]: accountTwoFactorRouteLoader,
	[routePattern(routes.admin)]: adminUsersRouteLoader,
	[routePattern(routes.adminUsers)]: adminUsersRouteLoader,
	[routePattern(routes.adminUserDetail)]: adminUsersRouteLoader,
	[routePattern(routes.adminInvites)]: adminInvitesRouteLoader,
	[routePattern(routes.adminFeatureFlags)]: adminFeatureFlagsRouteLoader,
	[routePattern(routes.adminRoles)]: adminRolesRouteLoader,
	[routePattern(routes.adminCommunityReports)]:
		adminCommunityReportsRouteLoader,
	[routePattern(routes.adminInsights)]: adminInsightsRouteLoader,
	[routePattern(routes.adminPlatformFeedback)]:
		adminPlatformFeedbackRouteLoader,
	[routePattern(routes.adminSystemEmail)]: adminSystemEmailRouteLoader,
	[routePattern(routes.blog)]: blogRouteLoader,
	[routePattern(routes.blogPost)]: blogPostRouteLoader,
	[routePattern(routes.community)]: communityRouteLoader,
	[routePattern(routes.communityDetail)]: communityDetailRouteLoader,
	[routePattern(routes.profile)]: profileRouteLoader,
	[routePattern(routes.timeline)]: timelineRouteLoader,
	[routePattern(routes.login)]: authProvidersRouteLoader,
	[routePattern(routes.signup)]: authProvidersRouteLoader,
	[oauthPaths.authorize]: oauthAuthorizeRouteLoader,
	[routePattern(routes.onboarding)]: onboardingRouteLoader,
	[routePattern(routes.pendingVerification)]: pendingVerificationRouteLoader,
}

export const clientRoutes = {
	[routePattern(routes.home)]: <HomeRoute />,
	[routePattern(routes.account)]: <AccountRoute />,
	[routePattern(routes.accountBilling)]: <AccountBillingRoute />,
	[routePattern(routes.accountUsage)]: <AccountUsageRoute />,
	[routePattern(routes.accountIntegrations)]: <AccountIntegrationsRoute />,
	[routePattern(routes.accountIntegrationDetail)]: <AccountIntegrationsRoute />,
	[routePattern(routes.accountMcpServers)]: <AccountMcpServersRoute />,
	[routePattern(routes.accountMcpServerNew)]: <AccountMcpServersRoute />,
	[routePattern(routes.accountMcpServerDetail)]: <AccountMcpServersRoute />,
	[routePattern(routes.accountPackageInvocationTokens)]: (
		<AccountPackageInvocationTokensRoute />
	),
	[routePattern(routes.accountPackageInvocationTokenNew)]: (
		<AccountPackageInvocationTokensRoute />
	),
	[routePattern(routes.accountPackageInvocationTokenDetail)]: (
		<AccountPackageInvocationTokensRoute />
	),
	[routePattern(routes.accountPackages)]: <AccountPackagesRoute />,
	[routePattern(routes.accountPackageDetail)]: <AccountPackagesRoute />,
	[routePattern(routes.accountStars)]: <AccountStarsRoute />,
	[routePattern(routes.accountPasskeys)]: <AccountPasskeysRoute />,
	[routePattern(routes.accountRemoteConnectors)]: (
		<AccountRemoteConnectorsRoute />
	),
	[routePattern(routes.accountRemoteConnectorNew)]: (
		<AccountRemoteConnectorsRoute />
	),
	[routePattern(routes.accountRemoteConnectorDetail)]: (
		<AccountRemoteConnectorsRoute />
	),
	[routePattern(routes.accountSecrets)]: <AccountSecretsRoute />,
	[routePattern(routes.accountSecretNew)]: <AccountSecretsRoute />,
	[routePattern(routes.accountSecretsApprove)]: <AccountSecretsRoute />,
	[routePattern(routes.accountSecretUserDetail)]: <AccountSecretsRoute />,
	[routePattern(routes.accountSecretPackageDetail)]: <AccountSecretsRoute />,
	[routePattern(routes.accountSecretSessionDetail)]: <AccountSecretsRoute />,
	[routePattern(routes.accountValues)]: <AccountValuesRoute />,
	[routePattern(routes.accountValueNew)]: <AccountValuesRoute />,
	[routePattern(routes.accountValueDetail)]: <AccountValuesRoute />,
	[routePattern(routes.accountJobs)]: <AccountJobsRoute />,
	[routePattern(routes.accountJobDetail)]: <AccountJobsRoute />,
	[routePattern(routes.accountMemories)]: <AccountMemoriesRoute />,
	[routePattern(routes.accountMemoryDetail)]: <AccountMemoriesRoute />,
	[routePattern(routes.accountEmail)]: <AccountEmailRoute />,
	[routePattern(routes.accountEmailDetail)]: <AccountEmailRoute />,
	[routePattern(routes.accountTwoFactor)]: <AccountTwoFactorRoute />,
	[routePattern(routes.admin)]: <AdminUsersRoute />,
	[routePattern(routes.adminUsers)]: <AdminUsersRoute />,
	[routePattern(routes.adminUserDetail)]: <AdminUsersRoute />,
	[routePattern(routes.adminInvites)]: <AdminInvitesRoute />,
	[routePattern(routes.adminFeatureFlags)]: <AdminFeatureFlagsRoute />,
	[routePattern(routes.adminRoles)]: <AdminRolesRoute />,
	[routePattern(routes.adminCommunityReports)]: <AdminCommunityReportsRoute />,
	[routePattern(routes.adminInsights)]: <AdminInsightsRoute />,
	[routePattern(routes.adminPlatformFeedback)]: <AdminPlatformFeedbackRoute />,
	[routePattern(routes.adminSystemEmail)]: <AdminSystemEmailRoute />,
	[routePattern(routes.blog)]: <BlogRoute />,
	[routePattern(routes.blogPost)]: <BlogPostRoute />,
	[routePattern(routes.community)]: <CommunityRoute />,
	[routePattern(routes.communityDetail)]: <CommunityDetailRoute />,
	[routePattern(routes.profile)]: <ProfileRoute />,
	[routePattern(routes.timeline)]: <TimelineRoute />,
	[routePattern(routes.login)]: <LoginRoute />,
	[routePattern(routes.onboarding)]: <OnboardingRoute />,
	[routePattern(routes.pendingVerification)]: <PendingVerificationRoute />,
	[routePattern(routes.privacy)]: <PrivacyRoute />,
	[routePattern(routes.terms)]: <TermsRoute />,
	[routePattern(routes.signup)]: <LoginRoute />,
	[routePattern(routes.resetPassword)]: <ResetPasswordRoute />,
	[routePattern(routes.verify)]: <VerifyRoute />,
	[routePattern(routes.verifyEmail)]: <VerifyEmailRoute />,
	[routePattern(routes.verifyEmailChange)]: <VerifyEmailRoute />,
	[routePattern(routes.connectOauth)]: <ConnectOauthRoute />,
	[oauthPaths.authorize]: <OAuthAuthorizeRoute />,
	[oauthPaths.callback]: <OAuthCallbackRoute />,
}
