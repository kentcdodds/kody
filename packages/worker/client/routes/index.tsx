import { type RouteLoader } from '#client/client-router.tsx'
import {
	accountArea,
	adminArea,
	blogArea,
	communityArea,
	LazyAccountRoute,
	LazyAdminRoute,
	LazyBlogRoute,
	LazyCommunityRoute,
	LazyOnboardingRoute,
	lazyRouteLoader,
	onboardingArea,
} from '#client/lazy-route.tsx'
import { oauthPaths } from '#app/oauth-paths.ts'
import { routePattern } from '#app/route-pattern.ts'
import { routes } from '#app/routes.ts'
import { HomeRoute, homeRouteLoader } from './home.tsx'
import { LoginRoute, authProvidersRouteLoader } from './login.tsx'
import {
	PendingVerificationRoute,
	pendingVerificationRouteLoader,
} from './pending-verification.tsx'
import { PrivacyRoute } from './privacy.tsx'
import { TermsRoute } from './terms.tsx'
import { OAuthCallbackRoute } from './oauth-callback.tsx'
import { ResetPasswordRoute } from './reset-password.tsx'
import { VerifyEmailRoute } from './verify-email.tsx'
import { VerifyRoute } from './verify.tsx'

export const clientRouteLoaders: Record<string, RouteLoader> = {
	[routePattern(routes.home)]: homeRouteLoader,
	[routePattern(routes.account)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountRouteLoader,
	),
	[routePattern(routes.accountBilling)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountBillingRouteLoader,
	),
	[routePattern(routes.accountUsage)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountUsageRouteLoader,
	),
	[routePattern(routes.accountIntegrations)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountIntegrationsRouteLoader,
	),
	[routePattern(routes.accountOauthAppDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountIntegrationsRouteLoader,
	),
	[routePattern(routes.accountIntegrationDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountIntegrationsRouteLoader,
	),
	[routePattern(routes.accountMcpServers)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountMcpServersRouteLoader,
	),
	[routePattern(routes.accountMcpServerNew)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountMcpServersRouteLoader,
	),
	[routePattern(routes.accountMcpServerDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountMcpServersRouteLoader,
	),
	[routePattern(routes.accountPackageInvocationTokens)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountPackageInvocationTokensRouteLoader,
	),
	[routePattern(routes.accountPackageInvocationTokenNew)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountPackageInvocationTokensRouteLoader,
	),
	[routePattern(routes.accountPackageInvocationTokenDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountPackageInvocationTokensRouteLoader,
	),
	[routePattern(routes.accountPackages)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountPackagesRouteLoader,
	),
	[routePattern(routes.accountPackageDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountPackagesRouteLoader,
	),
	[routePattern(routes.accountStars)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountStarsRouteLoader,
	),
	[routePattern(routes.accountPasskeys)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountPasskeysRouteLoader,
	),
	[routePattern(routes.accountRemoteConnectors)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountRemoteConnectorsRouteLoader,
	),
	[routePattern(routes.accountRemoteConnectorNew)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountRemoteConnectorsRouteLoader,
	),
	[routePattern(routes.accountRemoteConnectorDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountRemoteConnectorsRouteLoader,
	),
	[routePattern(routes.accountSecrets)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountSecretsRouteLoader,
	),
	[routePattern(routes.accountSecretNew)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountSecretsRouteLoader,
	),
	[routePattern(routes.accountSecretsApprove)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountSecretsRouteLoader,
	),
	[routePattern(routes.accountSecretUserDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountSecretsRouteLoader,
	),
	[routePattern(routes.accountSecretPackageDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountSecretsRouteLoader,
	),
	[routePattern(routes.accountSecretSessionDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountSecretsRouteLoader,
	),
	[routePattern(routes.accountValues)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountValuesRouteLoader,
	),
	[routePattern(routes.accountValueNew)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountValuesRouteLoader,
	),
	[routePattern(routes.accountValueDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountValuesRouteLoader,
	),
	[routePattern(routes.accountJobs)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountJobsRouteLoader,
	),
	[routePattern(routes.accountJobDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountJobsRouteLoader,
	),
	[routePattern(routes.accountActivity)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountActivityRouteLoader,
	),
	[routePattern(routes.accountActivityDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountActivityRouteLoader,
	),
	[routePattern(routes.accountMemories)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountMemoriesRouteLoader,
	),
	[routePattern(routes.accountMemoryDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountMemoriesRouteLoader,
	),
	[routePattern(routes.accountEmail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountEmailRouteLoader,
	),
	[routePattern(routes.accountEmailDetail)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountEmailRouteLoader,
	),
	[routePattern(routes.accountTwoFactor)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountTwoFactorRouteLoader,
	),
	[routePattern(routes.admin)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminUsersRouteLoader,
	),
	[routePattern(routes.adminUsers)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminUsersRouteLoader,
	),
	[routePattern(routes.adminUserDetail)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminUsersRouteLoader,
	),
	[routePattern(routes.adminInvites)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminInvitesRouteLoader,
	),
	[routePattern(routes.adminFeatureFlags)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminFeatureFlagsRouteLoader,
	),
	[routePattern(routes.adminRoles)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminRolesRouteLoader,
	),
	[routePattern(routes.adminCommunityReports)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminCommunityReportsRouteLoader,
	),
	[routePattern(routes.adminInsights)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminInsightsRouteLoader,
	),
	[routePattern(routes.adminPlatformFeedback)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminPlatformFeedbackRouteLoader,
	),
	[routePattern(routes.adminSystemEmail)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminSystemEmailRouteLoader,
	),
	[routePattern(routes.blog)]: lazyRouteLoader(
		blogArea,
		(m) => m.blogRouteLoader,
	),
	[routePattern(routes.blogPost)]: lazyRouteLoader(
		blogArea,
		(m) => m.blogPostRouteLoader,
	),
	[routePattern(routes.community)]: lazyRouteLoader(
		communityArea,
		(m) => m.communityRouteLoader,
	),
	[routePattern(routes.communityDetail)]: lazyRouteLoader(
		communityArea,
		(m) => m.communityDetailRouteLoader,
	),
	[routePattern(routes.profile)]: lazyRouteLoader(
		communityArea,
		(m) => m.profileRouteLoader,
	),
	[routePattern(routes.timeline)]: lazyRouteLoader(
		communityArea,
		(m) => m.timelineRouteLoader,
	),
	[routePattern(routes.login)]: authProvidersRouteLoader,
	[routePattern(routes.signup)]: authProvidersRouteLoader,
	[oauthPaths.authorize]: lazyRouteLoader(
		onboardingArea,
		(m) => m.oauthAuthorizeRouteLoader,
	),
	[routePattern(routes.onboarding)]: lazyRouteLoader(
		onboardingArea,
		(m) => m.onboardingRouteLoader,
	),
	[routePattern(routes.pendingVerification)]: pendingVerificationRouteLoader,
}

export const clientRoutes = {
	[routePattern(routes.home)]: <HomeRoute />,
	[routePattern(routes.account)]: (
		<LazyAccountRoute render={(m) => <m.AccountRoute />} />
	),
	[routePattern(routes.accountBilling)]: (
		<LazyAccountRoute render={(m) => <m.AccountBillingRoute />} />
	),
	[routePattern(routes.accountUsage)]: (
		<LazyAccountRoute render={(m) => <m.AccountUsageRoute />} />
	),
	[routePattern(routes.accountIntegrations)]: (
		<LazyAccountRoute render={(m) => <m.AccountIntegrationsRoute />} />
	),
	[routePattern(routes.accountOauthAppDetail)]: (
		<LazyAccountRoute render={(m) => <m.AccountIntegrationsRoute />} />
	),
	[routePattern(routes.accountIntegrationDetail)]: (
		<LazyAccountRoute render={(m) => <m.AccountIntegrationsRoute />} />
	),
	[routePattern(routes.accountMcpServers)]: (
		<LazyAccountRoute render={(m) => <m.AccountMcpServersRoute />} />
	),
	[routePattern(routes.accountMcpServerNew)]: (
		<LazyAccountRoute render={(m) => <m.AccountMcpServersRoute />} />
	),
	[routePattern(routes.accountMcpServerDetail)]: (
		<LazyAccountRoute render={(m) => <m.AccountMcpServersRoute />} />
	),
	[routePattern(routes.accountPackageInvocationTokens)]: (
		<LazyAccountRoute
			render={(m) => <m.AccountPackageInvocationTokensRoute />}
		/>
	),
	[routePattern(routes.accountPackageInvocationTokenNew)]: (
		<LazyAccountRoute
			render={(m) => <m.AccountPackageInvocationTokensRoute />}
		/>
	),
	[routePattern(routes.accountPackageInvocationTokenDetail)]: (
		<LazyAccountRoute
			render={(m) => <m.AccountPackageInvocationTokensRoute />}
		/>
	),
	[routePattern(routes.accountPackages)]: (
		<LazyAccountRoute render={(m) => <m.AccountPackagesRoute />} />
	),
	[routePattern(routes.accountPackageDetail)]: (
		<LazyAccountRoute render={(m) => <m.AccountPackagesRoute />} />
	),
	[routePattern(routes.accountStars)]: (
		<LazyAccountRoute render={(m) => <m.AccountStarsRoute />} />
	),
	[routePattern(routes.accountPasskeys)]: (
		<LazyAccountRoute render={(m) => <m.AccountPasskeysRoute />} />
	),
	[routePattern(routes.accountRemoteConnectors)]: (
		<LazyAccountRoute render={(m) => <m.AccountRemoteConnectorsRoute />} />
	),
	[routePattern(routes.accountRemoteConnectorNew)]: (
		<LazyAccountRoute render={(m) => <m.AccountRemoteConnectorsRoute />} />
	),
	[routePattern(routes.accountRemoteConnectorDetail)]: (
		<LazyAccountRoute render={(m) => <m.AccountRemoteConnectorsRoute />} />
	),
	[routePattern(routes.accountSecrets)]: (
		<LazyAccountRoute render={(m) => <m.AccountSecretsRoute />} />
	),
	[routePattern(routes.accountSecretNew)]: (
		<LazyAccountRoute render={(m) => <m.AccountSecretsRoute />} />
	),
	[routePattern(routes.accountSecretsApprove)]: (
		<LazyAccountRoute render={(m) => <m.AccountSecretsRoute />} />
	),
	[routePattern(routes.accountSecretUserDetail)]: (
		<LazyAccountRoute render={(m) => <m.AccountSecretsRoute />} />
	),
	[routePattern(routes.accountSecretPackageDetail)]: (
		<LazyAccountRoute render={(m) => <m.AccountSecretsRoute />} />
	),
	[routePattern(routes.accountSecretSessionDetail)]: (
		<LazyAccountRoute render={(m) => <m.AccountSecretsRoute />} />
	),
	[routePattern(routes.accountValues)]: (
		<LazyAccountRoute render={(m) => <m.AccountValuesRoute />} />
	),
	[routePattern(routes.accountValueNew)]: (
		<LazyAccountRoute render={(m) => <m.AccountValuesRoute />} />
	),
	[routePattern(routes.accountValueDetail)]: (
		<LazyAccountRoute render={(m) => <m.AccountValuesRoute />} />
	),
	[routePattern(routes.accountJobs)]: (
		<LazyAccountRoute render={(m) => <m.AccountJobsRoute />} />
	),
	[routePattern(routes.accountJobDetail)]: (
		<LazyAccountRoute render={(m) => <m.AccountJobsRoute />} />
	),
	[routePattern(routes.accountActivity)]: (
		<LazyAccountRoute render={(m) => <m.AccountActivityRoute />} />
	),
	[routePattern(routes.accountActivityDetail)]: (
		<LazyAccountRoute render={(m) => <m.AccountActivityRoute />} />
	),
	[routePattern(routes.accountMemories)]: (
		<LazyAccountRoute render={(m) => <m.AccountMemoriesRoute />} />
	),
	[routePattern(routes.accountMemoryDetail)]: (
		<LazyAccountRoute render={(m) => <m.AccountMemoriesRoute />} />
	),
	[routePattern(routes.accountEmail)]: (
		<LazyAccountRoute render={(m) => <m.AccountEmailRoute />} />
	),
	[routePattern(routes.accountEmailDetail)]: (
		<LazyAccountRoute render={(m) => <m.AccountEmailRoute />} />
	),
	[routePattern(routes.accountTwoFactor)]: (
		<LazyAccountRoute render={(m) => <m.AccountTwoFactorRoute />} />
	),
	[routePattern(routes.admin)]: (
		<LazyAdminRoute render={(m) => <m.AdminUsersRoute />} />
	),
	[routePattern(routes.adminUsers)]: (
		<LazyAdminRoute render={(m) => <m.AdminUsersRoute />} />
	),
	[routePattern(routes.adminUserDetail)]: (
		<LazyAdminRoute render={(m) => <m.AdminUsersRoute />} />
	),
	[routePattern(routes.adminInvites)]: (
		<LazyAdminRoute render={(m) => <m.AdminInvitesRoute />} />
	),
	[routePattern(routes.adminFeatureFlags)]: (
		<LazyAdminRoute render={(m) => <m.AdminFeatureFlagsRoute />} />
	),
	[routePattern(routes.adminRoles)]: (
		<LazyAdminRoute render={(m) => <m.AdminRolesRoute />} />
	),
	[routePattern(routes.adminCommunityReports)]: (
		<LazyAdminRoute render={(m) => <m.AdminCommunityReportsRoute />} />
	),
	[routePattern(routes.adminInsights)]: (
		<LazyAdminRoute render={(m) => <m.AdminInsightsRoute />} />
	),
	[routePattern(routes.adminPlatformFeedback)]: (
		<LazyAdminRoute render={(m) => <m.AdminPlatformFeedbackRoute />} />
	),
	[routePattern(routes.adminSystemEmail)]: (
		<LazyAdminRoute render={(m) => <m.AdminSystemEmailRoute />} />
	),
	[routePattern(routes.blog)]: (
		<LazyBlogRoute render={(m) => <m.BlogRoute />} />
	),
	[routePattern(routes.blogPost)]: (
		<LazyBlogRoute render={(m) => <m.BlogPostRoute />} />
	),
	[routePattern(routes.community)]: (
		<LazyCommunityRoute render={(m) => <m.CommunityRoute />} />
	),
	[routePattern(routes.communityDetail)]: (
		<LazyCommunityRoute render={(m) => <m.CommunityDetailRoute />} />
	),
	[routePattern(routes.profile)]: (
		<LazyCommunityRoute render={(m) => <m.ProfileRoute />} />
	),
	[routePattern(routes.timeline)]: (
		<LazyCommunityRoute render={(m) => <m.TimelineRoute />} />
	),
	[routePattern(routes.login)]: <LoginRoute />,
	[routePattern(routes.onboarding)]: (
		<LazyOnboardingRoute render={(m) => <m.OnboardingRoute />} />
	),
	[routePattern(routes.pendingVerification)]: <PendingVerificationRoute />,
	[routePattern(routes.privacy)]: <PrivacyRoute />,
	[routePattern(routes.terms)]: <TermsRoute />,
	[routePattern(routes.signup)]: <LoginRoute />,
	[routePattern(routes.resetPassword)]: <ResetPasswordRoute />,
	[routePattern(routes.verify)]: <VerifyRoute />,
	[routePattern(routes.verifyEmail)]: <VerifyEmailRoute />,
	[routePattern(routes.verifyEmailChange)]: <VerifyEmailRoute />,
	[routePattern(routes.connectOauth)]: (
		<LazyOnboardingRoute render={(m) => <m.ConnectOauthRoute />} />
	),
	[oauthPaths.authorize]: (
		<LazyOnboardingRoute render={(m) => <m.OAuthAuthorizeRoute />} />
	),
	[oauthPaths.callback]: <OAuthCallbackRoute />,
}
