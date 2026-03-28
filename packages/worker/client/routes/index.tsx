import { AccountRoute } from './account.tsx'
import { AccountSecretsRoute } from './account-secrets.tsx'
import { ChatRoute } from './chat.tsx'
import { ConnectSecretRoute } from './connect-secret.tsx'
import { HomeRoute } from './home.tsx'
import { LoginRoute } from './login.tsx'
import { OAuthAuthorizeRoute } from './oauth-authorize.tsx'
import { OAuthCallbackRoute } from './oauth-callback.tsx'
import { ResetPasswordRoute } from './reset-password.tsx'
import { SavedUiRoute } from './saved-ui.tsx'

export const clientRoutes = {
	'/': <HomeRoute />,
	'/chat': <ChatRoute />,
	'/chat/:threadId': <ChatRoute />,
	'/ui/:id': <SavedUiRoute />,
	'/connect/secret': <ConnectSecretRoute />,
	'/account': <AccountRoute />,
	'/account/secrets': <AccountSecretsRoute />,
	'/account/secrets/new': <AccountSecretsRoute />,
	'/account/secrets/approve': <AccountSecretsRoute />,
	'/account/secrets/:secretId': <AccountSecretsRoute />,
	'/account/secrets/user/:secretName': <AccountSecretsRoute />,
	'/account/secrets/app/:appId/:secretName': <AccountSecretsRoute />,
	'/account/secrets/session/:sessionId/:secretName': <AccountSecretsRoute />,
	'/login': <LoginRoute />,
	'/signup': <LoginRoute />,
	'/reset-password': <ResetPasswordRoute />,
	'/oauth/authorize': <OAuthAuthorizeRoute />,
	'/oauth/callback': <OAuthCallbackRoute />,
}
