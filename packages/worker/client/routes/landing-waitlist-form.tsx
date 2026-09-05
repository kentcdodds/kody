import { type Handle, ref } from 'remix/ui'
import { observeNearViewport } from '#client/deferred-turnstile.ts'
import { on } from '#client/event-mixin.ts'
import { fetchPublicAuthConfig } from '#client/social-sign-in.ts'
import { renderHoneypot } from '#client/honeypot-field.tsx'
import {
	readPublicFormProtection,
	renderTurnstileWidgets,
	resetTurnstileWidgets,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'
import {
	fieldErrorProps,
	invalidFieldsForMessage,
} from '#client/form-error-fields.ts'

/**
 * Connected-pill waitlist form (name · divider · email · button) with an
 * inline success swap. Posts to the real `/waiting-list` endpoint with the
 * same honeypot + Turnstile protection as the signup page. The challenge
 * script stays off first paint: it loads once the form is near the viewport.
 */
export function WaitlistForm(handle: Handle) {
	type Status = 'idle' | 'submitting' | 'success' | 'error'
	let status: Status = 'idle'
	let message: string | null = null
	let protectionArmed = false
	let turnstileSiteKey: string | null | undefined
	let widgetReady = false

	async function loadProtectionConfig(signal: AbortSignal) {
		if (turnstileSiteKey !== undefined) return
		const config = await fetchPublicAuthConfig(signal)
		if (signal.aborted) return
		turnstileSiteKey = config?.turnstileSiteKey ?? null
		handle.update()
	}

	function setState(nextStatus: Status, nextMessage: string | null = null) {
		status = nextStatus
		message = nextMessage
		handle.update()
	}

	function waitingForProtection() {
		if (!protectionArmed) return true
		if (turnstileSiteKey === undefined) return true
		return Boolean(turnstileSiteKey) && !widgetReady
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (status === 'submitting') return
		if (waitingForProtection()) return
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget

		const formData = new FormData(form)
		const firstName = String(formData.get('firstName') ?? '').trim()
		const email = String(formData.get('email') ?? '').trim()
		const protection = readPublicFormProtection(formData, form)

		if (!firstName) {
			setState('error', 'What should we call you?')
			form.querySelector<HTMLInputElement>('input[name="firstName"]')?.focus()
			return
		}
		// Stricter than type=email alone: require a TLD so "you@example"
		// bounces here, not at the server.
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
			setState('error', "That email doesn't look complete. Mind checking it?")
			form.querySelector<HTMLInputElement>('input[name="email"]')?.focus()
			return
		}

		setState('submitting')

		try {
			const response = await fetch('/waiting-list', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ firstName, email, ...protection }),
			})
			const payload = await response.json().catch(() => null)

			if (!response.ok) {
				const errorMessage =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to join the waiting list.'
				// The form stays mounted for another try, and the token it
				// carries has already been spent server-side.
				resetTurnstileWidgets()
				setState('error', errorMessage)
				return
			}

			const successMessage =
				typeof payload?.message === 'string'
					? payload.message
					: "You're on the list. We'll be in touch."
			setState('success', successMessage)
			// Success replaces the fields — including the submit button that
			// currently holds focus — so focus has to be placed deliberately
			// or it falls back to the top of the document.
			handle.queueTask(() => {
				form.querySelector<HTMLElement>('[data-waitlist-success]')?.focus()
			})
		} catch {
			resetTurnstileWidgets()
			setState('error', 'Network error. Please try again.')
		}
	}

	return () => {
		if (typeof document !== 'undefined' && protectionArmed) {
			if (turnstileSiteKey === undefined) {
				handle.queueTask(loadProtectionConfig)
			} else if (turnstileSiteKey) {
				handle.queueTask(async () => {
					try {
						await renderTurnstileWidgets(turnstileSiteKey ?? null)
					} catch {
						// Load/render failure must not pin the submit button
						// disabled. A later POST can still surface the server
						// error the way the immediate-load waitlist did.
					}
					if (widgetReady) return
					widgetReady = true
					handle.update()
				})
			}
		}
		const isSubmitting = status === 'submitting'
		const protectionPending = waitingForProtection()
		const submitDisabled = isSubmitting || protectionPending
		const statusId = `${handle.id}-waitlist-status`
		const invalidFields = invalidFieldsForMessage(status, message, [
			'firstName',
			'email',
		])

		return (
			<form
				noValidate
				class="landing-waitlist"
				mix={[
					on('submit', handleSubmit),
					on('input', () => {
						if (status !== 'error') return
						setState('idle')
					}),
					ref((node, signal) => {
						const stop = observeNearViewport(node, () => {
							if (protectionArmed) return
							protectionArmed = true
							handle.update()
						})
						signal.addEventListener('abort', stop, { once: true })
					}),
				]}
			>
				{/*
				 * A live region only announces text that changes while the
				 * region is already in the accessibility tree, so the announcer
				 * stays mounted for the life of the form. Success is left out:
				 * that state unmounts the submit button, so focus moves to the
				 * confirmation instead, which announces it once.
				 */}
				<p
					id={statusId}
					role={status === 'error' ? 'alert' : 'status'}
					class="visually-hidden"
				>
					{status === 'success' ? '' : (message ?? '')}
				</p>
				{status === 'success' ? (
					<p tabindex={-1} data-waitlist-success class="landing-form-success">
						{message}{' '}
						<button
							type="button"
							class="landing-form-reset"
							mix={on('click', () => {
								setState('idle')
								handle.queueTask(() => {
									document.getElementById(`${handle.id}-email`)?.focus()
								})
							})}
						>
							Wrong email?
						</button>
					</p>
				) : (
					<>
						<div data-focus-container class="landing-waitlist-fields">
							{renderHoneypot({ class: 'visually-hidden landing-honeypot' })}
							<label for={`${handle.id}-name`} class="visually-hidden">
								First name
							</label>
							<input
								id={`${handle.id}-name`}
								type="text"
								name="firstName"
								required
								maxLength={80}
								placeholder="First name"
								autoComplete="given-name"
								class="landing-waitlist-input"
								{...fieldErrorProps('firstName', invalidFields, statusId)}
							/>
							<label for={`${handle.id}-email`} class="visually-hidden">
								Email address
							</label>
							<input
								id={`${handle.id}-email`}
								type="email"
								name="email"
								required
								placeholder="you@yourdomain.dev"
								autoComplete="email"
								class="landing-waitlist-input landing-waitlist-email"
								{...fieldErrorProps('email', invalidFields, statusId)}
							/>
							<button
								type="submit"
								aria-disabled={submitDisabled ? 'true' : undefined}
								aria-busy={isSubmitting ? 'true' : undefined}
								class="landing-pill landing-pill-swap"
							>
								<span
									data-swap-label
									data-active={isSubmitting ? undefined : 'true'}
									aria-hidden={isSubmitting ? 'true' : undefined}
								>
									Join the waiting list
								</span>
								<span
									data-swap-label
									data-active={isSubmitting ? 'true' : undefined}
									aria-hidden={isSubmitting ? undefined : 'true'}
								>
									Joining…
								</span>
							</button>
						</div>
						{/*
						 * Reserve the managed widget box from first paint, even
						 * before the form is near the viewport and before the
						 * site key arrives. The challenge script still loads
						 * lazily; only the empty 300×65 host is in the HTML.
						 * `null` means Turnstile is off.
						 */}
						{turnstileSiteKey !== null ? (
							<div class={turnstileWidgetClassName}></div>
						) : null}
						{status === 'error' && message ? (
							// Announced by the mounted live region above.
							<p aria-hidden="true" class="landing-form-error">
								{message}
							</p>
						) : null}
					</>
				)}
			</form>
		)
	}
}
