import { type RouteLoader } from '#client/client-router.tsx'
import {
	accountArea,
	adminArea,
	authArea,
	blogArea,
	communityArea,
	LazyAccountRoute,
	LazyAdminRoute,
	LazyAuthRoute,
	LazyBlogRoute,
	LazyCommunityRoute,
	LazyMarketingRoute,
	LazyOnboardingRoute,
	LazyPackageFilesRoute,
	lazyRouteLoader,
	marketingArea,
	onboardingArea,
	packageFilesArea,
} from '#client/lazy-route.tsx'
import { InternalErrorPage } from '#client/internal-error-page.tsx'
import { NotFoundPage } from '#client/not-found-page.tsx'
import { oauthPaths } from '#universal/oauth-paths.ts'
import { routePattern } from '#universal/route-pattern.ts'
import { routes } from '#universal/routes.ts'
import {
	orgAccountClientLoaders,
	orgAccountClientRoutes,
} from './org-account-routes.tsx'
import { HomeRoute, homeRouteLoader } from './home.tsx'
import { OAuthCallbackRoute } from './oauth-callback.tsx'
import { ProfileRoute, profileRouteLoader } from './profile.tsx'

export const clientRouteLoaders: Record<string, RouteLoader> = {
	[routePattern(routes.home)]: homeRouteLoader,
	[routePattern(routes.account)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountRouteLoader,
	),
	[routePattern(routes.accountSecurity)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountRouteLoader,
	),
	[routePattern(routes.accountData)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountRouteLoader,
	),
	[routePattern(routes.accountUsage)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountUsageRouteLoader,
	),
	[routePattern(routes.accountExperiments)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountExperimentsRouteLoader,
	),
	[routePattern(routes.communityPackageApprovePublish)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountPackageApprovePublishRouteLoader,
	),
	[routePattern(routes.accountPackageFiles)]: lazyRouteLoader(
		packageFilesArea,
		(m) => m.packageFilesRouteLoader,
	),
	[routePattern(routes.accountPasskeys)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountPasskeysRouteLoader,
	),
	[routePattern(routes.accountMcpOauthClients)]: lazyRouteLoader(
		accountArea,
		(m) => m.accountMcpOauthClientsRouteLoader,
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
	[routePattern(routes.adminReservedUsernames)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminReservedUsernamesRouteLoader,
	),
	[routePattern(routes.adminFeatureFlags)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminFeatureFlagsRouteLoader,
	),
	[routePattern(routes.adminPlatformIntegrations)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminPlatformIntegrationsRouteLoader,
	),
	[routePattern(routes.adminPlatformIntegrationNew)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminPlatformIntegrationsRouteLoader,
	),
	[routePattern(routes.adminPlatformIntegrationDetail)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminPlatformIntegrationsRouteLoader,
	),
	[routePattern(routes.adminProviderMarks)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminProviderMarksRouteLoader,
	),
	[routePattern(routes.adminCodemods)]: lazyRouteLoader(
		adminArea,
		(m) => m.adminCodemodsRouteLoader,
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
	[routePattern(routes.docs)]: lazyRouteLoader(
		blogArea,
		(m) => m.docsIntroRouteLoader,
	),
	[routePattern(routes.docsConnect)]: lazyRouteLoader(
		blogArea,
		(m) => m.docsConnectRouteLoader,
	),
	[routePattern(routes.docDetail)]: lazyRouteLoader(
		blogArea,
		(m) => m.docDetailRouteLoader,
	),
	[routePattern(routes.community)]: lazyRouteLoader(
		communityArea,
		(m) => m.communityRouteLoader,
	),
	[routePattern(routes.communityDetail)]: lazyRouteLoader(
		communityArea,
		(m) => m.communityDetailRouteLoader,
	),
	[routePattern(routes.communityPackage)]: lazyRouteLoader(
		communityArea,
		(m) => m.communityDetailRouteLoader,
	),
	[routePattern(routes.communityPackageSettings)]: lazyRouteLoader(
		communityArea,
		(m) => m.communityDetailRouteLoader,
	),
	[routePattern(routes.communityDetailFiles)]: lazyRouteLoader(
		packageFilesArea,
		(m) => m.packageFilesRouteLoader,
	),
	[routePattern(routes.communityPackageFiles)]: lazyRouteLoader(
		packageFilesArea,
		(m) => m.packageFilesRouteLoader,
	),
	[routePattern(routes.communityPackageTree)]: lazyRouteLoader(
		packageFilesArea,
		(m) => m.packageFilesRouteLoader,
	),
	[routePattern(routes.profile)]: profileRouteLoader,
	[routePattern(routes.login)]: lazyRouteLoader(
		authArea,
		(m) => m.authProvidersRouteLoader,
	),
	[routePattern(routes.signup)]: lazyRouteLoader(
		authArea,
		(m) => m.authProvidersRouteLoader,
	),
	[oauthPaths.authorize]: lazyRouteLoader(
		onboardingArea,
		(m) => m.oauthAuthorizeRouteLoader,
	),
	[routePattern(routes.onboarding)]: lazyRouteLoader(
		onboardingArea,
		(m) => m.onboardingRouteLoader,
	),
	[routePattern(routes.onboardingStep1)]: lazyRouteLoader(
		onboardingArea,
		(m) => m.onboardingRouteLoader,
	),
	[routePattern(routes.onboardingStep1Agent)]: lazyRouteLoader(
		onboardingArea,
		(m) => m.onboardingRouteLoader,
	),
	[routePattern(routes.onboardingStep2)]: lazyRouteLoader(
		onboardingArea,
		(m) => m.onboardingRouteLoader,
	),
	[routePattern(routes.onboardingStep2Service)]: lazyRouteLoader(
		onboardingArea,
		(m) => m.onboardingRouteLoader,
	),
	[routePattern(routes.onboardingStep3)]: lazyRouteLoader(
		onboardingArea,
		(m) => m.onboardingRouteLoader,
	),
	[routePattern(routes.onboardingStep3Agent)]: lazyRouteLoader(
		onboardingArea,
		(m) => m.onboardingRouteLoader,
	),
	[routePattern(routes.connectOauth)]: lazyRouteLoader(
		onboardingArea,
		(m) => m.connectOauthRouteLoader,
	),
	[routePattern(routes.connectSecrets)]: lazyRouteLoader(
		onboardingArea,
		(m) => m.connectSecretsRouteLoader,
	),
	[routePattern(routes.connectSecretSet)]: lazyRouteLoader(
		onboardingArea,
		(m) => m.connectSecretSetRouteLoader,
	),
	[routePattern(routes.connectWebhookApply)]: lazyRouteLoader(
		onboardingArea,
		(m) => m.connectWebhookApplyRouteLoader,
	),
	[routePattern(routes.pendingVerification)]: lazyRouteLoader(
		authArea,
		(m) => m.pendingVerificationRouteLoader,
	),
	[routePattern(routes.discord)]: lazyRouteLoader(
		marketingArea,
		(m) => m.discordRouteLoader,
	),
	[routePattern(routes.pricing)]: lazyRouteLoader(
		marketingArea,
		(m) => m.pricingRouteLoader,
	),
	[routePattern(routes.faq)]: lazyRouteLoader(
		marketingArea,
		(m) => m.faqRouteLoader,
	),
	...orgAccountClientLoaders,
}

export const clientRoutes = {
	[routePattern(routes.home)]: <HomeRoute />,
	[routePattern(routes.notFoundPage)]: <NotFoundPage />,
	[routePattern(routes.internalErrorPage)]: <InternalErrorPage />,
	[routePattern(routes.account)]: (
		<LazyAccountRoute render={(m) => <m.AccountRoute />} />
	),
	[routePattern(routes.accountSecurity)]: (
		<LazyAccountRoute render={(m) => <m.AccountRoute />} />
	),
	[routePattern(routes.accountData)]: (
		<LazyAccountRoute render={(m) => <m.AccountRoute />} />
	),
	[routePattern(routes.accountUsage)]: (
		<LazyAccountRoute render={(m) => <m.AccountUsageRoute />} />
	),
	[routePattern(routes.accountExperiments)]: (
		<LazyAccountRoute render={(m) => <m.AccountExperimentsRoute />} />
	),
	[routePattern(routes.communityPackageApprovePublish)]: (
		<LazyAccountRoute render={(m) => <m.AccountPackageApprovePublishRoute />} />
	),
	[routePattern(routes.accountPackageFiles)]: (
		<LazyPackageFilesRoute render={(m) => <m.PackageFilesRoute />} />
	),
	[routePattern(routes.accountPasskeys)]: (
		<LazyAccountRoute render={(m) => <m.AccountPasskeysRoute />} />
	),
	[routePattern(routes.accountMcpOauthClients)]: (
		<LazyAccountRoute render={(m) => <m.AccountMcpOauthClientsRoute />} />
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
	[routePattern(routes.adminReservedUsernames)]: (
		<LazyAdminRoute render={(m) => <m.AdminReservedUsernamesRoute />} />
	),
	[routePattern(routes.adminFeatureFlags)]: (
		<LazyAdminRoute render={(m) => <m.AdminFeatureFlagsRoute />} />
	),
	[routePattern(routes.adminPlatformIntegrations)]: (
		<LazyAdminRoute render={(m) => <m.AdminPlatformIntegrationsRoute />} />
	),
	[routePattern(routes.adminPlatformIntegrationNew)]: (
		<LazyAdminRoute render={(m) => <m.AdminPlatformIntegrationsRoute />} />
	),
	[routePattern(routes.adminPlatformIntegrationDetail)]: (
		<LazyAdminRoute render={(m) => <m.AdminPlatformIntegrationsRoute />} />
	),
	[routePattern(routes.adminProviderMarks)]: (
		<LazyAdminRoute render={(m) => <m.AdminProviderMarksRoute />} />
	),
	[routePattern(routes.adminCodemods)]: (
		<LazyAdminRoute render={(m) => <m.AdminCodemodsRoute />} />
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
	[routePattern(routes.docs)]: (
		<LazyBlogRoute render={(m) => <m.DocDetailRoute />} />
	),
	[routePattern(routes.docsConnect)]: (
		<LazyBlogRoute render={(m) => <m.DocsConnectRoute />} />
	),
	[routePattern(routes.docDetail)]: (
		<LazyBlogRoute render={(m) => <m.DocDetailRoute />} />
	),
	[routePattern(routes.community)]: (
		<LazyCommunityRoute render={(m) => <m.CommunityRoute />} />
	),
	[routePattern(routes.communityDetail)]: (
		<LazyCommunityRoute render={(m) => <m.CommunityDetailRoute />} />
	),
	[routePattern(routes.communityPackage)]: (
		<LazyCommunityRoute render={(m) => <m.CommunityDetailRoute />} />
	),
	[routePattern(routes.communityPackageSettings)]: (
		<LazyCommunityRoute render={(m) => <m.PackageSettingsRoute />} />
	),
	[routePattern(routes.communityDetailFiles)]: (
		<LazyPackageFilesRoute render={(m) => <m.PackageFilesRoute />} />
	),
	[routePattern(routes.communityPackageFiles)]: (
		<LazyPackageFilesRoute render={(m) => <m.PackageFilesRoute />} />
	),
	[routePattern(routes.communityPackageTree)]: (
		<LazyPackageFilesRoute render={(m) => <m.PackageFilesRoute />} />
	),
	[routePattern(routes.profile)]: <ProfileRoute />,
	[routePattern(routes.login)]: (
		<LazyAuthRoute render={(m) => <m.LoginRoute />} />
	),
	[routePattern(routes.onboarding)]: (
		<LazyOnboardingRoute render={(m) => <m.OnboardingRoute />} />
	),
	[routePattern(routes.onboardingStep1)]: (
		<LazyOnboardingRoute render={(m) => <m.OnboardingRoute />} />
	),
	[routePattern(routes.onboardingStep1Agent)]: (
		<LazyOnboardingRoute render={(m) => <m.OnboardingRoute />} />
	),
	[routePattern(routes.onboardingStep2)]: (
		<LazyOnboardingRoute render={(m) => <m.OnboardingRoute />} />
	),
	[routePattern(routes.onboardingStep2Service)]: (
		<LazyOnboardingRoute render={(m) => <m.OnboardingRoute />} />
	),
	[routePattern(routes.onboardingStep3)]: (
		<LazyOnboardingRoute render={(m) => <m.OnboardingRoute />} />
	),
	[routePattern(routes.onboardingStep3Agent)]: (
		<LazyOnboardingRoute render={(m) => <m.OnboardingRoute />} />
	),
	[routePattern(routes.pendingVerification)]: (
		<LazyAuthRoute render={(m) => <m.PendingVerificationRoute />} />
	),
	[routePattern(routes.features)]: (
		<LazyMarketingRoute render={(m) => <m.FeaturesRoute />} />
	),
	[routePattern(routes.featureMemory)]: (
		<LazyMarketingRoute render={(m) => <m.MemoryRoute />} />
	),
	[routePattern(routes.featureSecrets)]: (
		<LazyMarketingRoute render={(m) => <m.SecretsRoute />} />
	),
	[routePattern(routes.featurePackages)]: (
		<LazyMarketingRoute render={(m) => <m.PackagesRoute />} />
	),
	[routePattern(routes.featureTriggers)]: (
		<LazyMarketingRoute render={(m) => <m.TriggersRoute />} />
	),
	[routePattern(routes.featureIntegrations)]: (
		<LazyMarketingRoute render={(m) => <m.IntegrationsRoute />} />
	),
	[routePattern(routes.featureApps)]: (
		<LazyMarketingRoute render={(m) => <m.AppsRoute />} />
	),
	[routePattern(routes.business)]: (
		<LazyMarketingRoute render={(m) => <m.BusinessRoute />} />
	),
	[routePattern(routes.pricing)]: (
		<LazyMarketingRoute render={(m) => <m.PricingRoute />} />
	),
	[routePattern(routes.faq)]: (
		<LazyMarketingRoute render={(m) => <m.FaqRoute />} />
	),
	[routePattern(routes.n8nAlternatives)]: (
		<LazyMarketingRoute
			render={(m) => <m.AcquisitionRoute pageKey="n8nAlternatives" />}
		/>
	),
	[routePattern(routes.mcpGateway)]: (
		<LazyMarketingRoute
			render={(m) => <m.AcquisitionRoute pageKey="mcpGateway" />}
		/>
	),
	[routePattern(routes.sharedMemory)]: (
		<LazyMarketingRoute
			render={(m) => <m.AcquisitionRoute pageKey="sharedMemory" />}
		/>
	),
	[routePattern(routes.gmail)]: (
		<LazyMarketingRoute
			render={(m) => <m.AcquisitionRoute pageKey="gmail" />}
		/>
	),
	[routePattern(routes.customTools)]: (
		<LazyMarketingRoute
			render={(m) => <m.AcquisitionRoute pageKey="customTools" />}
		/>
	),
	[routePattern(routes.composioAlternatives)]: (
		<LazyMarketingRoute
			render={(m) => <m.AcquisitionRoute pageKey="composioAlternatives" />}
		/>
	),
	[routePattern(routes.slack)]: (
		<LazyMarketingRoute
			render={(m) => <m.AcquisitionRoute pageKey="slack" />}
		/>
	),
	[routePattern(routes.scheduledWorkflows)]: (
		<LazyMarketingRoute
			render={(m) => <m.AcquisitionRoute pageKey="scheduledWorkflows" />}
		/>
	),
	[routePattern(routes.claudeIntegrations)]: (
		<LazyMarketingRoute
			render={(m) => <m.AcquisitionRoute pageKey="claudeIntegrations" />}
		/>
	),
	[routePattern(routes.useCases)]: (
		<LazyMarketingRoute
			render={(m) => <m.AcquisitionRoute pageKey="useCases" />}
		/>
	),
	[routePattern(routes.automation)]: (
		<LazyMarketingRoute
			render={(m) => <m.AcquisitionRoute pageKey="automation" />}
		/>
	),
	[routePattern(routes.caseStudies)]: (
		<LazyMarketingRoute render={(m) => <m.CaseStudiesRoute />} />
	),
	[routePattern(routes.support)]: (
		<LazyMarketingRoute render={(m) => <m.SupportRoute />} />
	),
	[routePattern(routes.privacy)]: (
		<LazyMarketingRoute render={(m) => <m.PrivacyRoute />} />
	),
	[routePattern(routes.terms)]: (
		<LazyMarketingRoute render={(m) => <m.TermsRoute />} />
	),
	[routePattern(routes.discord)]: (
		<LazyMarketingRoute render={(m) => <m.DiscordRoute />} />
	),
	[routePattern(routes.signup)]: (
		<LazyAuthRoute render={(m) => <m.LoginRoute />} />
	),
	[routePattern(routes.resetPassword)]: (
		<LazyAuthRoute render={(m) => <m.ResetPasswordRoute />} />
	),
	[routePattern(routes.verify)]: (
		<LazyAuthRoute render={(m) => <m.VerifyRoute />} />
	),
	[routePattern(routes.verifyEmail)]: (
		<LazyAuthRoute render={(m) => <m.VerifyEmailRoute />} />
	),
	[routePattern(routes.verifyEmailChange)]: (
		<LazyAuthRoute render={(m) => <m.VerifyEmailRoute />} />
	),
	[routePattern(routes.verifyEmailClaimRelease)]: (
		<LazyAuthRoute render={(m) => <m.VerifyEmailRoute />} />
	),
	[routePattern(routes.verifyEmailDestination)]: (
		<LazyAuthRoute render={(m) => <m.VerifyEmailRoute />} />
	),
	[routePattern(routes.unsubscribeTips)]: (
		<LazyAuthRoute render={(m) => <m.UnsubscribeTipsRoute />} />
	),
	[routePattern(routes.connectOauth)]: (
		<LazyOnboardingRoute render={(m) => <m.ConnectOauthRoute />} />
	),
	[routePattern(routes.connectSecrets)]: (
		<LazyOnboardingRoute render={(m) => <m.ConnectSecretsRoute />} />
	),
	[routePattern(routes.connectSecretSet)]: (
		<LazyOnboardingRoute render={(m) => <m.ConnectSecretSetRoute />} />
	),
	[routePattern(routes.connectWebhookApply)]: (
		<LazyOnboardingRoute render={(m) => <m.ConnectWebhookApplyRoute />} />
	),
	[oauthPaths.authorize]: (
		<LazyOnboardingRoute render={(m) => <m.OAuthAuthorizeRoute />} />
	),
	[oauthPaths.callback]: <OAuthCallbackRoute />,
	...orgAccountClientRoutes,
}
