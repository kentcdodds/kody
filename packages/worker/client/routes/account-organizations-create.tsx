import {
	handlePermanentNote,
	handleUrlPreview,
} from '@kody-internal/shared/handle-permanence.ts'
import {
	getHandleFormatError,
	handleFormatHint,
	suggestHandle,
} from '@kody-internal/shared/handle-rules.ts'
import { type Handle, css } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import { permanentHandleInputProps } from '#client/handle-field.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { routes } from '#universal/routes.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from './account-management-components.tsx'
import {
	formCss,
	postRestoreOrganization,
	slugFieldCss,
	slugInputCss,
	slugPrefixCss,
} from './account-organizations-shared.tsx'

function slugFromName(name: string) {
	return suggestHandle(name) ?? ''
}

function draftFromHref(href: string) {
	const search = new URL(href, 'http://localhost').searchParams
	return {
		draftName: search.get('displayName') ?? '',
		draftSlug: search.get('slug') ?? '',
		restorableSlug: search.get('restorableSlug'),
	}
}

export async function accountOrganizationsNewRouteLoader(): Promise<RouteLoaderResult> {
	return {}
}

export function AccountOrganizationsNewRoute(handle: Handle) {
	const initialHref = readCurrentRouterHref(handle)
	const consumed = tryConsumeRouteLoaderData(
		handle,
		'accountOrganizationsNew',
		initialHref,
	)
	let syncedHref = initialHref
	let loaderError = consumed?.error ?? null
	let restorableSlug =
		consumed?.restorableSlug ?? draftFromHref(initialHref).restorableSlug
	let { draftName, draftSlug } = consumed
		? { draftName: consumed.draft.displayName, draftSlug: consumed.draft.slug }
		: draftFromHref(initialHref)
	// A slug the person typed (or one sent back with an error) is theirs; only
	// an untouched slug follows the name.
	let slugEdited = draftSlug.length > 0
	let confirming = false
	let restoring = false
	let restoreError: string | null = null
	let clientError: string | null = null
	let clientErrorField: 'displayName' | 'slug' | null = null
	const handleInputProps = permanentHandleInputProps()
	const formErrorId = 'create-organization-form-error'

	async function restoreDraftOrg(slug: string) {
		if (restoring) return
		restoring = true
		restoreError = null
		handle.update()
		try {
			const payload = await postRestoreOrganization(slug)
			if (payload.redirectTo) {
				window.location.assign(payload.redirectTo)
				return
			}
			window.location.assign(routes.accountOrganizations.href())
		} catch (error) {
			restoreError =
				error instanceof Error
					? error.message
					: 'Unable to restore that organization.'
			restoring = false
			handle.update()
		}
	}

	return () => {
		const href = readCurrentRouterHref(handle)
		// A rejected submit redirects back here with a new draft and error while
		// this component stays mounted.
		if (href !== syncedHref) {
			syncedHref = href
			loaderError = null
			clientError = null
			clientErrorField = null
			restoreError = null
			;({ draftName, draftSlug, restorableSlug } = draftFromHref(href))
			slugEdited = draftSlug.length > 0
			confirming = false
		}
		const error =
			clientError ??
			loaderError ??
			new URL(href, 'http://localhost').searchParams.get('error')
		const offerRestore = Boolean(restorableSlug)
		const nameInvalid = clientErrorField === 'displayName'
		const slugInvalid =
			clientErrorField === 'slug' ||
			Boolean(
				error &&
				!clientError &&
				!offerRestore &&
				/(handle|slug|taken|reserved)/i.test(error),
			)
		return (
			<AccountManagementShell maxWidth="40rem">
				<AccountPageHeader
					title="Create organization"
					description="An organization owns its own packages, secrets, and members, separate from your personal account."
					currentHref={href}
				/>
				{error ? (
					<AccountManagementMessage tone={offerRestore ? 'info' : 'error'}>
						<span id={formErrorId}>{error}</span>
					</AccountManagementMessage>
				) : null}
				{restoreError ? (
					<AccountManagementMessage tone="error">
						{restoreError}
					</AccountManagementMessage>
				) : null}
				{offerRestore && restorableSlug ? (
					<div mix={css(accountActionsCss)} data-testid="create-org-restore">
						<button
							type="button"
							disabled={restoring}
							mix={[
								css(getPillButtonCss({ size: 'sm' })),
								on('click', () => void restoreDraftOrg(restorableSlug!)),
							]}
						>
							{restoring ? 'Restoring…' : `Restore @${restorableSlug}`}
						</button>
						<a
							href={routes.accountOrganizations.href()}
							mix={css(getGhostButtonCss({ size: 'sm' }))}
						>
							View deleted organizations
						</a>
					</div>
				) : null}
				<AccountManagementPanel title="Details">
					<form
						method="post"
						action={routes.accountOrganizationsNewPost.href()}
						data-testid="create-organization-form"
						noValidate
						mix={[
							css(formCss),
							on('submit', (event) => {
								const displayName = draftName.trim()
								if (!displayName || displayName.length > 80) {
									event.preventDefault()
									clientError = 'Enter a name up to 80 characters.'
									clientErrorField = 'displayName'
									confirming = false
									handle.update()
									return
								}
								// Format only on the client (same as signup). Reserved
								// names — including admin KV unreserves — are enforced by
								// server createOrg; a built-in-only block would reject
								// handles the server would accept.
								const slugError = getHandleFormatError(draftSlug.trim(), {
									label: 'Handle',
								})
								if (slugError) {
									event.preventDefault()
									clientError = slugError
									clientErrorField = 'slug'
									confirming = false
									handle.update()
									return
								}
								clientError = null
								clientErrorField = null
								// Handles are permanent, so the first submit shows the final
								// URL and asks once before the organization is created.
								if (confirming) return
								event.preventDefault()
								confirming = true
								handle.update()
							}),
						]}
					>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>Name</span>
							<input
								name="displayName"
								required
								maxLength={80}
								autoComplete="organization"
								value={draftName}
								data-field-ring
								aria-invalid={nameInvalid ? 'true' : undefined}
								aria-describedby={nameInvalid ? formErrorId : undefined}
								mix={[
									css(accountInputCss),
									on('input', (event) => {
										draftName = (event.currentTarget as HTMLInputElement).value
										clientError = null
										clientErrorField = null
										if (!slugEdited) {
											const nextSlug = slugFromName(draftName)
											// A handle the person has not seen confirmed is not confirmed.
											if (nextSlug !== draftSlug) confirming = false
											draftSlug = nextSlug
										}
										handle.update()
									}),
								]}
							/>
							<p mix={css(accountFieldNoteCss)}>
								Shown in the header and to members. You can change it later.
							</p>
						</label>
						<label mix={css(accountFieldCss)}>
							<span mix={css(accountFieldLabelCss)}>Handle</span>
							<span mix={css(slugFieldCss)}>
								<span aria-hidden="true" mix={css(slugPrefixCss)}>
									kody.codes/@
								</span>
								<input
									name="slug"
									required
									autoComplete="off"
									aria-describedby={
										slugInvalid
											? `create-organization-slug-note ${formErrorId}`
											: 'create-organization-slug-note'
									}
									aria-invalid={slugInvalid ? 'true' : undefined}
									value={draftSlug}
									data-field-ring
									{...handleInputProps}
									mix={[
										css(slugInputCss),
										on('input', (event) => {
											draftSlug = (
												event.currentTarget as HTMLInputElement
											).value.toLowerCase()
											slugEdited = draftSlug.length > 0
											confirming = false
											clientError = null
											clientErrorField = null
											handle.update()
										}),
									]}
								/>
							</span>
							<p
								id="create-organization-slug-note"
								mix={css(accountFieldNoteCss)}
							>
								{handleFormatHint} {handlePermanentNote} Your organization's URL
								will be{' '}
								<strong data-testid="create-organization-url-preview">
									{handleUrlPreview(draftSlug || 'your-handle')}
								</strong>
								.
							</p>
						</label>
						{confirming ? (
							<p
								role="status"
								data-testid="create-organization-confirm"
								mix={css(accountFieldNoteCss)}
							>
								Your organization URL will be{' '}
								<strong>{handleUrlPreview(draftSlug)}</strong>. This can't be
								changed. Create it?
							</p>
						) : null}
						<div mix={css(accountActionsCss)}>
							<button type="submit" mix={css(getPillButtonCss({ size: 'sm' }))}>
								{confirming
									? 'Yes, create organization'
									: 'Create organization'}
							</button>
							<a
								href={routes.accountOrganizations.href()}
								mix={css(getGhostButtonCss({ size: 'sm' }))}
							>
								Cancel
							</a>
						</div>
					</form>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
