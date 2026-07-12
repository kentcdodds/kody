import { type RouteLoader } from '#client/client-router.tsx'
import { AccountRoute, accountRouteLoader } from './account.tsx'
import {
	AccountIntegrationsRoute,
	accountIntegrationsRouteLoader,
} from './account-integrations.tsx'
import {
	AccountMcpServersRoute,
	accountMcpServersRouteLoader,
} from './account-mcp-servers.tsx'
import {
	AccountPackageInvocationTokensRoute,
	accountPackageInvocationTokensRouteLoader,
} from './account-package-invocation-tokens.tsx'
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
	AdminCommunityReportsRoute,
	adminCommunityReportsRouteLoader,
} from './admin-community-reports.tsx'
import {
	AdminInsightsRoute,
	adminInsightsRouteLoader,
} from './admin-insights.tsx'
import { AdminInvitesRoute, adminInvitesRouteLoader } from './admin-invites.tsx'
import { AdminRolesRoute, adminRolesRouteLoader } from './admin-roles.tsx'
import {
	AdminSystemEmailRoute,
	adminSystemEmailRouteLoader,
} from './admin-system-email.tsx'
import { AdminUsersRoute, adminUsersRouteLoader } from './admin-users.tsx'
import {
	CommunityDetailRoute,
	communityDetailRouteLoader,
} from './community-detail.tsx'
import { CommunityRoute, communityRouteLoader } from './community.tsx'
import { ConnectOauthRoute } from './connect-oauth.tsx'
import { HomeRoute, homeRouteLoader } from './home.tsx'
import { LoginRoute, authProvidersRouteLoader } from './login.tsx'
import { OnboardingRoute, onboardingRouteLoader } from './onboarding.tsx'
import {
	PendingVerificationRoute,
	pendingVerificationRouteLoader,
} from './pending-verification.tsx'
import { PrivacyRoute } from './privacy.tsx'
import {
	OAuthAuthorizeRoute,
	oauthAuthorizeRouteLoader,
} from './oauth-authorize.tsx'
import { OAuthCallbackRoute } from './oauth-callback.tsx'
import { ResetPasswordRoute } from './reset-password.tsx'
import { VerifyEmailRoute } from './verify-email.tsx'
import { VerifyRoute } from './verify.tsx'

export const clientRouteLoaders: Record<string, RouteLoader> = {
	'/': homeRouteLoader,
	'/account': accountRouteLoader,
	'/account/integrations': accountIntegrationsRouteLoader,
	'/account/mcp-servers': accountMcpServersRouteLoader,
	'/account/package-invocation-tokens':
		accountPackageInvocationTokensRouteLoader,
	'/account/package-invocation-tokens/new':
		accountPackageInvocationTokensRouteLoader,
	'/account/package-invocation-tokens/:tokenId':
		accountPackageInvocationTokensRouteLoader,
	'/account/passkeys': accountPasskeysRouteLoader,
	'/account/remote-connectors': accountRemoteConnectorsRouteLoader,
	'/account/secrets': accountSecretsRouteLoader,
	'/account/secrets/new': accountSecretsRouteLoader,
	'/account/secrets/approve': accountSecretsRouteLoader,
	'/account/secrets/user/:secretName': accountSecretsRouteLoader,
	'/account/secrets/package/:packageId/:secretName': accountSecretsRouteLoader,
	'/account/secrets/session/:sessionId/:secretName': accountSecretsRouteLoader,
	'/account/two-factor': accountTwoFactorRouteLoader,
	'/admin': adminUsersRouteLoader,
	'/admin/users': adminUsersRouteLoader,
	'/admin/invites': adminInvitesRouteLoader,
	'/admin/roles': adminRolesRouteLoader,
	'/admin/community-reports': adminCommunityReportsRouteLoader,
	'/admin/insights': adminInsightsRouteLoader,
	'/admin/system-email': adminSystemEmailRouteLoader,
	'/community': communityRouteLoader,
	'/community/:listingId': communityDetailRouteLoader,
	'/login': authProvidersRouteLoader,
	'/signup': authProvidersRouteLoader,
	'/oauth/authorize': oauthAuthorizeRouteLoader,
	'/onboarding': onboardingRouteLoader,
	'/pending-verification': pendingVerificationRouteLoader,
}

export const clientRoutes = {
	'/': <HomeRoute />,
	'/account': <AccountRoute />,
	'/account/integrations': <AccountIntegrationsRoute />,
	'/account/mcp-servers': <AccountMcpServersRoute />,
	'/account/package-invocation-tokens': <AccountPackageInvocationTokensRoute />,
	'/account/package-invocation-tokens/new': (
		<AccountPackageInvocationTokensRoute />
	),
	'/account/package-invocation-tokens/:tokenId': (
		<AccountPackageInvocationTokensRoute />
	),
	'/account/passkeys': <AccountPasskeysRoute />,
	'/account/remote-connectors': <AccountRemoteConnectorsRoute />,
	'/account/secrets': <AccountSecretsRoute />,
	'/account/secrets/new': <AccountSecretsRoute />,
	'/account/secrets/approve': <AccountSecretsRoute />,
	'/account/secrets/user/:secretName': <AccountSecretsRoute />,
	'/account/secrets/package/:packageId/:secretName': <AccountSecretsRoute />,
	'/account/secrets/session/:sessionId/:secretName': <AccountSecretsRoute />,
	'/account/two-factor': <AccountTwoFactorRoute />,
	'/admin': <AdminUsersRoute />,
	'/admin/users': <AdminUsersRoute />,
	'/admin/invites': <AdminInvitesRoute />,
	'/admin/roles': <AdminRolesRoute />,
	'/admin/community-reports': <AdminCommunityReportsRoute />,
	'/admin/insights': <AdminInsightsRoute />,
	'/admin/system-email': <AdminSystemEmailRoute />,
	'/community': <CommunityRoute />,
	'/community/:listingId': <CommunityDetailRoute />,
	'/login': <LoginRoute />,
	'/onboarding': <OnboardingRoute />,
	'/pending-verification': <PendingVerificationRoute />,
	'/privacy': <PrivacyRoute />,
	'/signup': <LoginRoute />,
	'/reset-password': <ResetPasswordRoute />,
	'/verify': <VerifyRoute />,
	'/verify-email': <VerifyEmailRoute />,
	'/verify-email-change': <VerifyEmailRoute />,
	'/connect/oauth': <ConnectOauthRoute />,
	'/oauth/authorize': <OAuthAuthorizeRoute />,
	'/oauth/callback': <OAuthCallbackRoute />,
}
