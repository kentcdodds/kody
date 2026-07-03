import { AccountRoute } from './account.tsx'
import { AccountIntegrationsRoute } from './account-integrations.tsx'
import { AccountPackageInvocationTokensRoute } from './account-package-invocation-tokens.tsx'
import { AccountRemoteConnectorsRoute } from './account-remote-connectors.tsx'
import { AccountSecretsRoute } from './account-secrets.tsx'
import { AdminRolesRoute } from './admin-roles.tsx'
import { AdminUsersRoute } from './admin-users.tsx'
import { ConnectOauthRoute } from './connect-oauth.tsx'
import { HomeRoute } from './home.tsx'
import { LoginRoute } from './login.tsx'
import { PrivacyRoute } from './privacy.tsx'
import { OAuthAuthorizeRoute } from './oauth-authorize.tsx'
import { OAuthCallbackRoute } from './oauth-callback.tsx'
import { ResetPasswordRoute } from './reset-password.tsx'

export const clientRoutes = {
	'/': <HomeRoute />,
	'/account': <AccountRoute />,
	'/account/integrations': <AccountIntegrationsRoute />,
	'/account/package-invocation-tokens': <AccountPackageInvocationTokensRoute />,
	'/account/package-invocation-tokens/new': (
		<AccountPackageInvocationTokensRoute />
	),
	'/account/package-invocation-tokens/:tokenId': (
		<AccountPackageInvocationTokensRoute />
	),
	'/account/remote-connectors': <AccountRemoteConnectorsRoute />,
	'/account/secrets': <AccountSecretsRoute />,
	'/account/secrets/new': <AccountSecretsRoute />,
	'/account/secrets/approve': <AccountSecretsRoute />,
	'/account/secrets/:secretId': <AccountSecretsRoute />,
	'/account/secrets/user/:secretName': <AccountSecretsRoute />,
	'/account/secrets/app/:appId/:secretName': <AccountSecretsRoute />,
	'/account/secrets/session/:sessionId/:secretName': <AccountSecretsRoute />,
	'/admin': <AdminUsersRoute />,
	'/admin/users': <AdminUsersRoute />,
	'/admin/roles': <AdminRolesRoute />,
	'/login': <LoginRoute />,
	'/privacy': <PrivacyRoute />,
	'/signup': <LoginRoute />,
	'/reset-password': <ResetPasswordRoute />,
	'/connect/oauth': <ConnectOauthRoute />,
	'/oauth/authorize': <OAuthAuthorizeRoute />,
	'/oauth/callback': <OAuthCallbackRoute />,
}
