import { dnsSafeUsernamePattern } from '@kody-internal/shared/public-urls.ts'
import { type ProfileVisibility } from '#universal/loader-data.ts'

const usernameFormatRequirements =
	'Use 3 to 32 letters, numbers, and hyphens. Start and end with a letter or number.'

export type AccountProfileSavePayload = {
	ok?: boolean
	username?: string
	error?: unknown
	packageUpdateMessage?: string
	communityUpdateWarning?: string
}

export type AccountProfileSaveResult =
	| { status: 'error'; message: string }
	| {
			status: 'saved'
			message: string
			appliedUsername: string
			usernameChanged: boolean
	  }
	| { status: 'noop'; appliedUsername: string }

function normalizeProfileUsername(value: unknown) {
	return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function readApiErrorMessage(payload: unknown, fallback: string) {
	if (!payload || typeof payload !== 'object') return fallback
	const error = (payload as { error?: unknown }).error
	if (typeof error === 'string' && error.trim()) return error
	if (error && typeof error === 'object' && 'message' in error) {
		const message = (error as { message?: unknown }).message
		if (typeof message === 'string' && message.trim()) return message
	}
	return fallback
}

export function usernameFormatError(username: string) {
	const normalized = normalizeProfileUsername(username)
	if (!normalized) return 'Username is required.'
	if (!dnsSafeUsernamePattern.test(normalized)) {
		return usernameFormatRequirements
	}
	return null
}

export function readProfileFormValues(
	form: EventTarget | null,
	fallback: {
		username: string
		displayName: string
		bio: string
		profileVisibility: ProfileVisibility
	},
) {
	if (
		typeof HTMLFormElement === 'undefined' ||
		!(form instanceof HTMLFormElement)
	) {
		return fallback
	}
	const data = new FormData(form)
	const username = String(data.get('username') ?? fallback.username)
	const displayName = String(data.get('displayName') ?? fallback.displayName)
	const bio = String(data.get('bio') ?? fallback.bio)
	const visibilityValue = data.get('profileVisibility')
	const profileVisibility =
		visibilityValue === 'public' || visibilityValue === 'private'
			? visibilityValue
			: fallback.profileVisibility
	return {
		username,
		displayName,
		bio,
		profileVisibility,
	}
}

export function interpretAccountProfileSave(input: {
	previousUsername: string
	requestedUsername: string
	profileFieldsChanged: boolean
	responseOk: boolean
	payload: AccountProfileSavePayload | null
}): AccountProfileSaveResult {
	const previousUsername = normalizeProfileUsername(input.previousUsername)
	const requestedUsername = normalizeProfileUsername(input.requestedUsername)
	const usernameChangeRequested =
		requestedUsername !== '' && requestedUsername !== previousUsername
	const fallbackError = usernameChangeRequested
		? `Could not change username to \`${requestedUsername}\`.`
		: 'Unable to save profile.'

	if (!input.responseOk || !input.payload?.ok) {
		return {
			status: 'error',
			message: readApiErrorMessage(input.payload, fallbackError),
		}
	}

	const appliedUsername = normalizeProfileUsername(input.payload.username)
	if (usernameChangeRequested && appliedUsername !== requestedUsername) {
		return {
			status: 'error',
			message: readApiErrorMessage(
				input.payload,
				`\`${requestedUsername}\` was not saved.`,
			),
		}
	}

	if (!usernameChangeRequested && !input.profileFieldsChanged) {
		return {
			status: 'noop',
			appliedUsername: appliedUsername || previousUsername,
		}
	}

	const message = [
		'Profile saved.',
		usernameChangeRequested ? input.payload.packageUpdateMessage : null,
		usernameChangeRequested ? input.payload.communityUpdateWarning : null,
	]
		.filter(Boolean)
		.join(' ')

	return {
		status: 'saved',
		message,
		appliedUsername: appliedUsername || previousUsername,
		usernameChanged: usernameChangeRequested,
	}
}
