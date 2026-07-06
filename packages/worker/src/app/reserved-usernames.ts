/**
 * Static denylist for usernames that must not be claimed by end users.
 * Covers brand/product identity, support/trust surfaces, infrastructure and
 * route-like names, and RFC 5321 mailbox locals commonly used for system mail.
 */
const reservedUsernameList = [
	// Brand / product
	'kody',
	'kodybot',
	'kody-bot',
	'kodyassistant',
	'kody-assistant',
	'kodyapp',
	'kody-app',
	'kodyhq',
	'kody-hq',
	'kodyai',
	'kody-ai',

	// Support / trust / safety
	'support',
	'help',
	'helpdesk',
	'help-desk',
	'trust',
	'safety',
	'security',
	'abuse',
	'report',
	'feedback',
	'contact',
	'info',

	// Staff / elevated roles
	'admin',
	'administrator',
	'root',
	'system',
	'sysadmin',
	'superuser',
	'sudo',
	'owner',
	'staff',
	'team',
	'moderator',
	'mod',
	'ops',
	'devops',

	// Infrastructure / web / routing
	'api',
	'www',
	'mail',
	'email',
	'smtp',
	'imap',
	'pop',
	'pop3',
	'dns',
	'ftp',
	'ssh',
	'ssl',
	'tls',
	'cdn',
	'static',
	'assets',
	'status',
	'health',
	'ping',
	'monitor',
	'metrics',
	'logs',
	'webhook',
	'webhooks',
	'callback',
	'callbacks',
	'oauth',
	'auth',
	'login',
	'logout',
	'signup',
	'register',
	'account',
	'profile',
	'settings',
	'billing',
	'payments',
	'subscribe',
	'unsubscribe',
	'community',
	'mcp',
	'connect',
	'connector',
	'connectors',
	'package',
	'packages',
	'session',
	'sessions',
	'verify',
	'reset',
	'password',
	'privacy',
	'terms',
	'legal',
	'dmca',
	'copyright',
	'trademark',

	// Email mailbox locals (RFC 5321 / common system addresses)
	'postmaster',
	'hostmaster',
	'webmaster',
	'noreply',
	'no-reply',
	'donotreply',
	'do-not-reply',
	'bounce',
	'mailer-daemon',
	'mailerdaemon',
	'mailer_daemon',

	// Ambiguous / environment / placeholder
	'null',
	'undefined',
	'anonymous',
	'guest',
	'public',
	'private',
	'internal',
	'external',
	'localhost',
	'local',
	'dev',
	'staging',
	'stage',
	'prod',
	'production',
	'test',
	'preview',
	'demo',
	'sandbox',
	'example',
	'sample',
	'official',
	'verified',
] as const

const reservedUsernames = new Set<string>(reservedUsernameList)

export function isReservedUsername(username: string) {
	return reservedUsernames.has(username.trim().toLowerCase())
}

export function getReservedUsernameError(username: string) {
	if (isReservedUsername(username)) {
		return 'This username is reserved.'
	}
	return null
}
