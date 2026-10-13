import { type Handle } from 'remix/component'
import { createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'
import {
	installProgressWords,
	releasePackageTitleInstallProgress,
	startPackageTitleInstallProgress,
	stopPackageTitleInstallProgress,
} from '#client/package-title-install-progress.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	type CommunityInstallUiState,
	createPackageTitleInstallArm,
	decideCommunityInstallClick,
	isCommunityInstallConfirmArmed,
	paintPackageTitleInstallConfirm,
	shouldResetInstallConfirm,
	shouldResetInstallOnShellSnapshot,
} from '#client/routes/community-detail-install.ts'
import { renderInstallStrip } from '#client/routes/community-detail-sections.tsx'
import {
	type CommunityInstallApiPayload,
	type CommunityInstallOutcome,
} from '#client/routes/community-detail-shared.ts'
import { routes } from '#universal/routes.ts'

/**
 * The Fork control in the repository action group, shared by every tab that
 * shows it (Repo and Files). First click arms "Confirm fork", blur or an
 * outside click disarms, the second click POSTs while the control shows the
 * install stage words. The tab supplies which listing is on screen so a late
 * response for another listing is dropped, and refreshes its action group
 * after a successful fork.
 */
export function createCommunityInstallController(
	handle: Handle,
	options: {
		getActiveListingId(): string | null
		onInstalled(): void
	},
) {
	let installState: CommunityInstallUiState = 'idle'
	let installMessage: string | null = null
	let installOutcome: CommunityInstallOutcome | null = null
	const installConfirm = createDoubleCheck(handle)
	let installConfirmListingId: string | null = null
	const installArm = createPackageTitleInstallArm({
		confirm: installConfirm,
		getListingId: () => installConfirmListingId,
		setListingId: (listingId) => {
			installConfirmListingId = listingId
		},
	})

	function clearOutcome() {
		installState = 'idle'
		installMessage = null
		installOutcome = null
	}

	async function submitInstall(listingId: string) {
		if (installState === 'submitting') return
		installState = 'submitting'
		installMessage = null
		startPackageTitleInstallProgress(installProgressWords, listingId)
		handle.update()

		try {
			const response = await fetch(
				routes.communityInstallApiPost.href({ listingId }),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					// The labeled control is the acknowledgement. Third-party installs
					// still require this flag; the tooltip carries the warning.
					body: JSON.stringify({ acknowledged: true }),
				},
			)
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<CommunityInstallApiPayload>(response)
			// A late response for a previous listing must not overwrite the
			// state of the listing currently on screen, or stop a newer run.
			if (options.getActiveListingId() !== listingId) {
				stopPackageTitleInstallProgress({ listingId, restore: true })
				return
			}
			if (response.status === 409 && payload?.requiresAcknowledgement) {
				throw new Error(
					payload.error ?? 'Unable to install this public package.',
				)
			}
			if (
				!response.ok ||
				!payload?.ok ||
				!payload.status ||
				!payload.targetName ||
				!payload.agentPrompt
			) {
				throw new Error(
					payload?.error ?? 'Unable to install this public package.',
				)
			}
			installOutcome = {
				status: payload.status,
				targetName: payload.targetName,
				agentPrompt: payload.agentPrompt,
				packageId:
					payload.status === 'installed' ? (payload.packageId ?? null) : null,
				failedChecks: payload.failedChecks ?? [],
			}
			installState = 'idle'
			stopPackageTitleInstallProgress({ listingId, restore: false })
			handle.update()
			options.onInstalled()
		} catch (error) {
			if (options.getActiveListingId() !== listingId) {
				stopPackageTitleInstallProgress({ listingId, restore: true })
				return
			}
			stopPackageTitleInstallProgress({ listingId })
			installState = 'error'
			installMessage =
				error instanceof Error
					? error.message
					: 'Unable to install this public package.'
			handle.update()
		}
	}

	function handleClick(event: Event) {
		const target = event.target
		if (!(target instanceof Element)) return
		const control = target.closest('[data-community-install]')
		// A click that does not move focus never fires focusout. Drop the
		// armed flag here so the next click on Fork has to arm again.
		if (!control) {
			installArm.disarm()
			return
		}
		const loginLink = control instanceof HTMLAnchorElement
		const listingId = control.getAttribute('data-package-title-listing')
		const decision = decideCommunityInstallClick({
			installState: loginLink ? 'idle' : installState,
			alreadyInstalled: loginLink ? false : installOutcome != null,
			requiresConfirm: !loginLink,
			confirmed: isCommunityInstallConfirmArmed({
				confirmed: installConfirm.doubleCheck,
				confirmedListingId: installConfirmListingId,
				listingId,
			}),
		})
		switch (decision) {
			case 'ignore':
				if (!loginLink) event.preventDefault()
				return
			case 'arm':
				event.preventDefault()
				installArm.arm(control, listingId)
				return
			case 'submit':
				if (loginLink) return
				event.preventDefault()
				installArm.reset()
				if (listingId) void submitInstall(listingId)
				return
			default: {
				const exhaustive: never = decision
				throw new Error(`Unhandled install click: ${String(exhaustive)}`)
			}
		}
	}

	function handleFocusOut(event: FocusEvent) {
		const target = event.target
		if (!(target instanceof Element)) return
		const control = target.closest('[data-community-install]')
		if (
			!control ||
			!isCommunityInstallConfirmArmed({
				confirmed: installConfirm.doubleCheck,
				confirmedListingId: installConfirmListingId,
				listingId: control.getAttribute('data-package-title-listing'),
			})
		) {
			return
		}
		const next = event.relatedTarget
		if (next instanceof Node && control.contains(next)) return
		installArm.reset()
		paintPackageTitleInstallConfirm(control, false)
	}

	return {
		mixins: [on('click', handleClick), on('focusout', handleFocusOut)],

		/**
		 * A fresh snapshot of the tab's data arrived. Keep an in-flight install
		 * for the same listing (its control is already clickable again), and
		 * drop the armed confirm when the snapshot is another listing.
		 */
		applySnapshot(listingId: string | null) {
			const releasedProgress = releasePackageTitleInstallProgress(listingId)
			if (
				shouldResetInstallOnShellSnapshot({ installState, releasedProgress })
			) {
				clearOutcome()
			}
			if (
				shouldResetInstallConfirm({
					confirmedListingId: installConfirmListingId,
					listingId,
				})
			) {
				installArm.reset()
			}
		},

		/**
		 * The path changed and the tab is about to rebuild the action group, so
		 * the control comes back idle. Restore the spinner's listing first.
		 */
		navigated(listingId: string | null) {
			if (releasePackageTitleInstallProgress(listingId)) clearOutcome()
			installArm.reset()
		},

		renderStrip() {
			return renderInstallStrip({ installMessage, installOutcome })
		},
	}
}
