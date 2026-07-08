import {
	type GitHubAuthProfile,
	type GoogleAuthProfile,
	type OAuthResult,
	type XAuthProfile,
} from 'remix/auth'
import { getUniqueConstraintField } from '#app/database-errors.ts'
import { normalizeEmail } from '#app/normalize-email.ts'
import {
	consumeInviteCode,
	getInviteFailureMessage,
	releaseInviteUse,
} from '#app/invites.ts'
import { assignUserRole } from '#app/permissions-db.ts'
import {
	getUsernameValidationError,
	normalizeUsername,
	usernameFromEmail,
} from '#app/username.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { type SocialAuthProviderName } from '#app/social-auth-providers.ts'
import {
	authConnectionsTable,
	createDb,
	type AppDatabase,
	usersTable,
} from '#worker/db.ts'
import { ensureDefaultEmailInbox } from '#worker/email/default-inbox.ts'
import { getPlatformEmailDomain } from '#worker/email/platform-address.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const oauthOnlyPasswordHash = 'oauth_only_no_usable_password'

export type ResolvedSocialAuthUser = {
	userId: number
	email: string
	isNewUser: boolean
	provider: SocialAuthProviderName
	providerId: string
}

type SocialAuthProfile = GitHubAuthProfile | GoogleAuthProfile | XAuthProfile

function isInviteRequiredForSignup(env: Env) {
	return !isNonProductionRuntime(env)
}

function readProfileEmail(
	provider: SocialAuthProviderName,
	profile: SocialAuthProfile,
) {
	if (provider === 'github') {
		const githubProfile = profile as GitHubAuthProfile
		return normalizeEmail(githubProfile.email ?? '')
	}

	if (provider === 'google') {
		const googleProfile = profile as GoogleAuthProfile
		return normalizeEmail(googleProfile.email ?? '')
	}

	return ''
}

function readProfileUsername(
	provider: SocialAuthProviderName,
	profile: SocialAuthProfile,
	email: string,
) {
	if (provider === 'github') {
		const githubProfile = profile as GitHubAuthProfile
		return normalizeUsername(githubProfile.login || usernameFromEmail(email))
	}

	if (provider === 'google') {
		const googleProfile = profile as GoogleAuthProfile
		const preferred = googleProfile.preferred_username ?? googleProfile.name
		return normalizeUsername(preferred || usernameFromEmail(email))
	}

	const xProfile = profile as XAuthProfile
	return normalizeUsername(xProfile.username)
}

function syntheticEmailForProvider(
	provider: SocialAuthProviderName,
	providerId: string,
) {
	return normalizeEmail(`${provider}+${providerId}@oauth.kody.invalid`)
}

function isProviderEmailVerified(
	provider: SocialAuthProviderName,
	profile: SocialAuthProfile,
) {
	if (provider === 'google') {
		return (profile as GoogleAuthProfile).email_verified === true
	}
	return provider !== 'x'
}

async function userExistsByUsername(db: AppDatabase, username: string) {
	return Boolean(
		await db.findOne(usersTable, {
			where: { username },
		}),
	)
}

async function getAvailableUsername(
	db: AppDatabase,
	provider: SocialAuthProviderName,
	profile: SocialAuthProfile,
	email: string,
) {
	const preferred = readProfileUsername(provider, profile, email)
	if (
		!getUsernameValidationError(preferred) &&
		!(await userExistsByUsername(db, preferred))
	) {
		return preferred
	}

	const fromEmail = usernameFromEmail(email)
	if (
		!getUsernameValidationError(fromEmail) &&
		!(await userExistsByUsername(db, fromEmail))
	) {
		return fromEmail
	}

	const prefix = fromEmail.slice(0, 27).replace(/[-_]+$/g, '') || 'user'
	for (let suffix = 2; suffix <= 100; suffix += 1) {
		const candidate = `${prefix}-${suffix}`
		if (
			!getUsernameValidationError(candidate) &&
			!(await userExistsByUsername(db, candidate))
		) {
			return candidate
		}
	}

	const bytes = new Uint8Array(3)
	crypto.getRandomValues(bytes)
	const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.toLowerCase()
	return `user-${random}`
}

async function createAuthConnection(
	db: AppDatabase,
	input: {
		userId: number
		provider: SocialAuthProviderName
		providerId: string
	},
) {
	const existing = await db.findOne(authConnectionsTable, {
		where: {
			provider_name: input.provider,
			provider_id: input.providerId,
		},
	})

	if (existing) {
		if (existing.user_id !== input.userId) {
			throw new Error('This social account is already linked to another user.')
		}
		return existing
	}

	return db.create(
		authConnectionsTable,
		{
			user_id: input.userId,
			provider_name: input.provider,
			provider_id: input.providerId,
		},
		{ returnRow: true },
	)
}

async function createOAuthUser(input: {
	db: AppDatabase
	env: Env
	provider: SocialAuthProviderName
	providerId: string
	profile: SocialAuthProfile
	inviteCode?: string
}) {
	const email =
		readProfileEmail(input.provider, input.profile) ||
		syntheticEmailForProvider(input.provider, input.providerId)
	const username = await getAvailableUsername(
		input.db,
		input.provider,
		input.profile,
		email,
	)
	const emailVerified = isProviderEmailVerified(input.provider, input.profile)
	let consumedInviteCode: string | null = null

	async function releaseConsumedInvite() {
		if (!consumedInviteCode) return
		await releaseInviteUse({
			db: input.env.APP_DB,
			code: consumedInviteCode,
		})
		consumedInviteCode = null
	}

	const inviteRequired = isInviteRequiredForSignup(input.env)
	if (inviteRequired || input.inviteCode) {
		const inviteResult = await consumeInviteCode({
			db: input.env.APP_DB,
			code: input.inviteCode,
		})
		if (!inviteResult.ok) {
			throw new SocialAuthResolutionError(
				getInviteFailureMessage(inviteResult.reason),
				inviteResult.reason === 'missing' && inviteRequired ? 400 : 403,
			)
		}
		consumedInviteCode = inviteResult.invite.code
	}

	let record: { id: number } | null = null
	try {
		const stableUserId = await createStableUserIdFromEmail(email)
		const createdUser = await input.db.create(
			usersTable,
			{
				username,
				email,
				stable_user_id: stableUserId,
				password_hash: oauthOnlyPasswordHash,
				...(emailVerified
					? { email_verified_at: new Date().toISOString() }
					: {}),
			},
			{ returnRow: true },
		)
		record = { id: createdUser.id }
	} catch (error) {
		const uniqueField = getUniqueConstraintField(error)
		if (uniqueField === 'email' || uniqueField === 'username') {
			await releaseConsumedInvite()
			throw new SocialAuthResolutionError(
				uniqueField === 'username'
					? 'Username already registered.'
					: 'Email already registered.',
				409,
			)
		}
		await releaseConsumedInvite()
		throw error
	}

	if (!record) {
		await releaseConsumedInvite()
		throw new SocialAuthResolutionError('Unable to create account.', 500)
	}

	let assigned = false
	try {
		;({ assigned } = await assignUserRole({
			db: input.env.APP_DB,
			userId: record.id,
			roleName: 'user',
		}))
	} catch (error) {
		console.error('Failed to assign default role for OAuth signup:', error)
	}

	if (!assigned) {
		try {
			await input.env.APP_DB.prepare(`DELETE FROM users WHERE id = ?`)
				.bind(record.id)
				.run()
		} catch (error) {
			console.error(
				'Failed to remove user row after OAuth role assignment failure:',
				error,
			)
		}
		await releaseConsumedInvite()
		throw new SocialAuthResolutionError('Unable to create account.', 500)
	}

	try {
		await createAuthConnection(input.db, {
			userId: record.id,
			provider: input.provider,
			providerId: input.providerId,
		})
		const platformEmailDomain = getPlatformEmailDomain(input.env)
		if (platformEmailDomain) {
			try {
				await ensureDefaultEmailInbox({
					db: input.env.APP_DB,
					userId: await createStableUserIdFromEmail(email),
					username,
					domain: platformEmailDomain,
				})
			} catch (error) {
				console.warn(
					'Failed to provision default email inbox for OAuth signup:',
					error,
				)
			}
		}
	} catch (error) {
		try {
			await input.env.APP_DB.prepare(`DELETE FROM users WHERE id = ?`)
				.bind(record.id)
				.run()
		} catch (deleteError) {
			console.error(
				'Failed to remove user row after OAuth connection setup failure:',
				deleteError,
			)
		}
		await releaseConsumedInvite()
		throw error
	}

	return {
		userId: record.id,
		email,
		isNewUser: true,
	}
}

export class SocialAuthResolutionError extends Error {
	readonly status: number

	constructor(message: string, status: number) {
		super(message)
		this.name = 'SocialAuthResolutionError'
		this.status = status
	}
}

export async function resolveSocialAuthUser(input: {
	env: Env
	result: OAuthResult<SocialAuthProfile, SocialAuthProviderName>
	inviteCode?: string
}): Promise<ResolvedSocialAuthUser> {
	const provider = input.result.provider
	const providerId = input.result.account.providerAccountId
	const db = createDb(input.env.APP_DB)

	const existingConnection = await db.findOne(authConnectionsTable, {
		where: {
			provider_name: provider,
			provider_id: providerId,
		},
	})

	if (existingConnection) {
		const user = await db.findOne(usersTable, {
			where: { id: existingConnection.user_id },
		})
		if (!user) {
			throw new SocialAuthResolutionError('Linked account is missing.', 500)
		}
		return {
			userId: user.id,
			email: user.email,
			isNewUser: false,
			provider,
			providerId,
		}
	}

	const profileEmail = readProfileEmail(provider, input.result.profile)
	if (profileEmail) {
		const existingUser = await db.findOne(usersTable, {
			where: { email: profileEmail },
		})
		if (existingUser) {
			await createAuthConnection(db, {
				userId: existingUser.id,
				provider,
				providerId,
			})
			return {
				userId: existingUser.id,
				email: existingUser.email,
				isNewUser: false,
				provider,
				providerId,
			}
		}
	}

	const created = await createOAuthUser({
		db,
		env: input.env,
		provider,
		providerId,
		profile: input.result.profile,
		inviteCode: input.inviteCode,
	})

	return {
		userId: created.userId,
		email: created.email,
		isNewUser: created.isNewUser,
		provider,
		providerId,
	}
}
