import { type Handle } from 'remix/ui'
import { type AccountFormerEmail } from '#universal/loader-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'

const emailChangeApiPath = '/account/email-change.json'
const emailClaimReleaseApiPath = '/account/email-claim-release.json'

export function createAccountEmailClaims(handle: Handle) {
	let emailChangeStatus: 'idle' | 'sending' = 'idle'
	let emailChangeOpen = false
	let formerEmails: Array<AccountFormerEmail> = []
	let releaseEmail = ''
	let releasePassword = ''
	let releaseStatus: 'idle' | 'sending' = 'idle'
	let releaseMessage: string | null = null
	let releaseTone: 'error' | 'info' = 'info'
	let draftEmail = ''
	let emailChangePassword = ''
	let emailChangeMessage: string | null = null
	let emailChangeTone: 'error' | 'info' = 'info'

	function applyFormerEmails(nextFormerEmails: Array<AccountFormerEmail>) {
		formerEmails = nextFormerEmails
	}

	function applyCurrentEmail(email: string) {
		draftEmail = email
	}

	function updateDraftEmail(event: InputEvent) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		draftEmail = event.currentTarget.value
		handle.update()
	}

	function updateEmailChangePassword(event: InputEvent) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		emailChangePassword = event.currentTarget.value
		handle.update()
	}

	function updateReleaseEmail(event: InputEvent) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		releaseEmail = event.currentTarget.value
		handle.update()
	}

	function updateReleasePassword(event: InputEvent) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		releasePassword = event.currentTarget.value
		handle.update()
	}

	function useFormerEmailAsLogin(nextEmail: string) {
		draftEmail = nextEmail
		emailChangeOpen = true
		emailChangeMessage = null
		handle.update()
	}

	async function requestFormerEmailRelease(nextEmail: string) {
		if (!releasePassword) {
			releaseEmail = nextEmail
			releaseMessage = 'Current password is required to send a release link.'
			releaseTone = 'error'
			handle.update()
			return
		}
		releaseEmail = nextEmail
		handle.update()
		await submitFormerEmailRelease()
	}

	async function handleFormerEmailReleaseSubmit(event: SubmitEvent) {
		event.preventDefault()
		await submitFormerEmailRelease()
	}

	async function submitFormerEmailRelease() {
		const nextEmail = releaseEmail.trim().toLowerCase()
		if (!nextEmail || !releasePassword) {
			releaseMessage = 'Former email and current password are required.'
			releaseTone = 'error'
			handle.update()
			return
		}

		releaseStatus = 'sending'
		releaseMessage = null
		releaseTone = 'info'
		handle.update()

		try {
			const response = await fetch(emailClaimReleaseApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					email: nextEmail,
					password: releasePassword,
				}),
			})
			if (response.status === 401) {
				const payload = await readJson<{ code?: string; error?: string }>(
					response,
				)
				if (payload?.code === 'invalid_password') {
					throw new Error(payload.error)
				}
				window.location.assign('/login')
				return
			}
			const payload = await readJson<{
				ok?: boolean
				message?: string
				error?: string
			}>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(
					payload?.error || 'Unable to send the release verification.',
				)
			}
			releasePassword = ''
			releaseMessage =
				payload.message ?? 'Verification email sent to that former address.'
			releaseTone = 'info'
		} catch (error) {
			releaseMessage =
				error instanceof Error
					? error.message
					: 'Unable to send the release verification.'
			releaseTone = 'error'
		} finally {
			releaseStatus = 'idle'
			handle.update()
		}
	}

	async function handleEmailChangeSubmit(
		event: SubmitEvent,
		currentEmail: string,
	) {
		event.preventDefault()
		const nextEmail = draftEmail.trim().toLowerCase()
		if (!nextEmail || !emailChangePassword) {
			emailChangeMessage = 'New email and current password are required.'
			emailChangeTone = 'error'
			handle.update()
			return
		}
		if (nextEmail === currentEmail.trim().toLowerCase()) {
			emailChangeMessage = 'Enter a different email address.'
			emailChangeTone = 'error'
			handle.update()
			return
		}

		emailChangeStatus = 'sending'
		emailChangeMessage = null
		emailChangeTone = 'info'
		handle.update()

		try {
			const response = await fetch(emailChangeApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					email: nextEmail,
					password: emailChangePassword,
				}),
			})
			if (response.status === 401) {
				const payload = await readJson<{ code?: string; error?: string }>(
					response,
				)
				if (payload?.code === 'invalid_password') {
					throw new Error(payload.error)
				}
				window.location.assign('/login')
				return
			}
			const payload = await readJson<{
				ok?: boolean
				message?: string
				error?: string
			}>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(
					payload?.error || 'Unable to send the email change verification.',
				)
			}
			emailChangePassword = ''
			emailChangeMessage =
				payload.message ?? 'Verification email sent to your new address.'
			emailChangeTone = 'info'
		} catch (error) {
			emailChangeMessage =
				error instanceof Error
					? error.message
					: 'Unable to send the email change verification.'
			emailChangeTone = 'error'
		} finally {
			emailChangeStatus = 'idle'
			handle.update()
		}
	}

	return {
		applyFormerEmails,
		applyCurrentEmail,
		updateDraftEmail,
		updateEmailChangePassword,
		updateReleaseEmail,
		updateReleasePassword,
		useFormerEmailAsLogin,
		requestFormerEmailRelease,
		handleFormerEmailReleaseSubmit,
		handleEmailChangeSubmit,
		get snapshot() {
			return {
				emailChangeStatus,
				emailChangeOpen,
				formerEmails,
				releaseEmail,
				releasePassword,
				releaseStatus,
				releaseMessage,
				releaseTone,
				draftEmail,
				emailChangePassword,
				emailChangeMessage,
				emailChangeTone,
			}
		},
	}
}
