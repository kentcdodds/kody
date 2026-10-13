import { type Handle, type RemixNode, css } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { orgAccountApiFetchInit } from '#client/org-account-api.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { PasswordRevealInput } from '#client/password-reveal-input.tsx'
import {
	type RouteLoaderResult,
	routeLoaderRedirect,
} from '#client/route-loader.ts'
import {
	accountSecretsApiPath,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import { AccountManagementShell } from '#client/routes/account-management-components.tsx'
import {
	buildKeySaveBody,
	createKeyFormState,
	credentialCreateAgentPrompt,
	credentialCreateFormKey,
	credentialCreateHandoffHref,
	credentialCreateMode,
	credentialCreateTitle,
	credentialNeedApprovalHref,
	expiresAtDateValue,
	expiresAtHasTime,
	existingKindConflict,
	findExistingOrgKey,
	findMatchingCredentials,
	isValueFormKind,
	keyFormPackageId,
	keyFormProblem,
	keyLinkProblem,
	type KeyFormState,
	type ValueFormKind,
} from '#client/routes/connect-credential-shared.ts'
import {
	renderLoginExchange,
	renderLoginFields,
} from '#client/routes/connect-credential-login-fields.tsx'
import {
	renderKindList,
	renderMatches,
	renderPackageAccess,
} from '#client/routes/connect-credential-parts.tsx'
import {
	type CredentialKind,
	type CredentialListItem,
	credentialKinds,
	parseCredentialCreateQuery,
} from '#universal/credential-contracts.ts'
import {
	type AccountCredentialsResponse,
	credentialKindLabel,
} from '#universal/credentials-list.ts'
import { orgResourcePath, orgSlugFromPathname } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	cardCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

const accountCredentialsApiPath = routes.accountCredentialsApi.href()

const primaryButtonCss = getPrimaryButtonCss({ size: 'lg', weight: 'semibold' })
const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

const mutedCss = { margin: 0, color: colors.textMuted }
const errorCss = { margin: 0, color: colors.danger }
const labelHintCss = {
	fontWeight: typography.fontWeight.normal,
	color: colors.textMuted,
}

/**
 * `/connect/credential` has no org; the worker redirects it to the signup
 * org's `/@slug/-/credentials/new`, so leave the SPA and let it.
 */
export async function connectCredentialRedirectLoader(
	url: URL,
): Promise<RouteLoaderResult> {
	return routeLoaderRedirect(`${url.pathname}${url.search}`)
}

export async function connectCredentialRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(
		accountCredentialsApiPath,
		orgAccountApiFetchInit(url.href, signal),
	)
	if (response.status === 401) {
		return routeLoaderRedirect(
			`/login?redirectTo=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
		)
	}
	const payload = await readJson<AccountCredentialsResponse>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load your credentials.')
	}
	return { accountCredentials: payload }
}

function valuePlaceholder(kind: ValueFormKind) {
	switch (kind) {
		case 'secret':
			return 'Paste the value'
		case 'url':
			return 'https://hooks.example.com/…'
		case 'signing':
			return 'Paste the signing secret or private key'
		case 'login':
			return ''
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

function hostsHint(kind: ValueFormKind) {
	switch (kind) {
		case 'secret':
			return 'Kody fills the value only on HTTPS requests to these hosts.'
		case 'url':
			return 'Kody sends this URL only to these hosts. Its own host must be one of them.'
		case 'login':
			return 'Kody logs in and sends the session token only to these hosts. The exchange URL must be on one of them.'
		case 'signing':
			return 'Kody signs only for requests to these hosts.'
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

/**
 * `/connect/credential`: the creation link agents hand out. One page picks
 * the kind (fixed when the link requires it), saves a Key, URL, login, or
 * signing credential in place, and hands OAuth and MCP to their own flows with
 * the link's prefill.
 */
export function ConnectCredentialRoute(handle: Handle) {
	let data: AccountCredentialsResponse | null = null
	let form: KeyFormState | null = null
	let formForHref = ''
	let showValue = false
	let saving = false
	let savedName: string | null = null
	let savedPackageId: string | null = null
	let message: string | null = null

	function resetFor(href: string) {
		const query = parseCredentialCreateQuery(
			new URL(href, 'http://localhost').searchParams,
		)
		form = createKeyFormState(query)
		formForHref = credentialCreateFormKey(href)
		savedName = null
		message = null
		showValue = false
	}

	async function refreshCredentials() {
		const response = await fetch(accountCredentialsApiPath, {
			headers: { Accept: 'application/json' },
			credentials: 'include',
		})
		const payload = await readJson<AccountCredentialsResponse>(response)
		if (response.ok && payload?.ok) data = payload
	}

	async function saveKey(event: SubmitEvent, kind: ValueFormKind) {
		event.preventDefault()
		if (saving || !form) return
		const current = form
		const problem = keyFormProblem(current, kind)
		if (problem) {
			message = problem
			handle.update()
			return
		}
		const existing = findExistingOrgKey(
			data?.credentials ?? [],
			current.name,
			keyFormPackageId(current, kind),
		)
		const kindConflict = existingKindConflict(existing, kind)
		if (kindConflict) {
			message = kindConflict
			handle.update()
			return
		}
		if (existing && !current.replaceExisting) {
			message = `A credential named ${current.name.trim()} already exists. Choose “Replace it” or pick another name.`
			handle.update()
			return
		}
		const save = buildKeySaveBody({ kind, form: current, existing })
		if (!save.ok) {
			message = save.error
			handle.update()
			return
		}
		saving = true
		message = null
		handle.update()
		try {
			const response = await fetch(accountSecretsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify(save.body),
			})
			if (response.status === 401) {
				window.location.assign(
					`/login?redirectTo=${encodeURIComponent(readCurrentRouterHref(handle))}`,
				)
				return
			}
			const payload = await readJson<{ ok?: boolean; error?: string }>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to save this credential.')
			}
			savedName = current.name.trim()
			savedPackageId = keyFormPackageId(current, kind)
			form = { ...current, value: '', loginFields: {} }
			await refreshCredentials()
		} catch (error) {
			message = error instanceof Error ? error.message : 'Unable to save.'
		} finally {
			saving = false
			handle.update()
		}
	}

	function renderKeyForm(input: {
		kind: ValueFormKind
		state: KeyFormState
		existing: CredentialListItem | null
		orgSlug: string
		/** Only on org paths: an org-less link cannot say which org owns the package. */
		forNeed: { orgSlug: string; packageKodyId: string; needKey: string } | null
		prompt: (error: string) => string
		packages: AccountCredentialsResponse['packages']
		linkProblem: string | null
	}) {
		const { kind, state, existing } = input
		const isKey = kind === 'secret'
		const kindConflict = existingKindConflict(existing, kind)
		const update = (patch: Partial<KeyFormState>) => {
			form = { ...state, ...patch }
			handle.update()
		}
		if (savedName) {
			const saved = findExistingOrgKey(
				data?.credentials ?? [],
				savedName,
				savedPackageId,
			)
			const approvalHref =
				saved && input.forNeed
					? credentialNeedApprovalHref({
							...input.forNeed,
							credentialId: saved.id,
						})
					: null
			return (
				<section mix={css(cardCss)} data-testid="connect-credential-saved">
					<p mix={css({ margin: 0 })}>
						<strong>{savedName}</strong> is saved. Return to your agent and
						continue.
					</p>
					{approvalHref && input.forNeed ? (
						<p mix={css({ margin: 0 })}>
							If <code>{input.forNeed.packageKodyId}</code> should always use it
							for <code>{input.forNeed.needKey}</code>,{' '}
							<a href={approvalHref} data-testid="connect-credential-approve">
								make it your default
							</a>
							.
						</p>
					) : null}
					{saved ? (
						<a
							href={orgResourcePath(
								input.orgSlug,
								'credentials',
								encodeURIComponent(saved.id),
							)}
							mix={css(secondaryButtonCss)}
						>
							View credential
						</a>
					) : null}
				</section>
			)
		}
		return (
			<section mix={css(cardCss)} data-testid="connect-credential-key-form">
				<form
					{...passwordManagerIgnoreProps}
					mix={[
						css({ display: 'grid', gap: spacing.md }),
						on('submit', (event) => {
							void saveKey(event, kind)
						}),
					]}
				>
					<div mix={css(fieldCss)}>
						<label for="connect-credential-name" mix={css(fieldLabelCss)}>
							Name
						</label>
						<input
							id="connect-credential-name"
							required
							pattern="[a-zA-Z0-9._\-]+"
							value={state.name}
							placeholder="OPENAI_API_KEY"
							mix={[
								css(inputCss),
								on('input', (event) =>
									update({
										name: event.currentTarget.value,
										replaceExisting: false,
									}),
								),
							]}
						/>
						<span mix={css(mutedCss)}>
							{isKey ? (
								<>
									Code refers to it as{' '}
									<code>{`{{secret:${state.name || 'NAME'}}}`}</code>.
								</>
							) : (
								'Packages ask Kody to use it by name. They never see the value.'
							)}
						</span>
					</div>
					{kindConflict ? (
						<p
							mix={css(errorCss)}
							data-testid="connect-credential-kind-conflict"
						>
							{kindConflict}
						</p>
					) : existing ? (
						<label
							mix={css({
								display: 'flex',
								gap: spacing.sm,
								alignItems: 'center',
							})}
						>
							<input
								type="checkbox"
								checked={state.replaceExisting}
								data-testid="connect-credential-replace"
								mix={on('change', (event) => {
									const replaceExisting = event.currentTarget.checked
									update({
										replaceExisting,
										provider:
											replaceExisting && !state.provider.trim()
												? (existing.provider ?? '')
												: state.provider,
									})
								})}
							/>
							<span>
								{isKey ? (
									<>
										A credential named <code>{existing.name}</code> already
										exists. Replace it (its hosts and package locks stay).
									</>
								) : (
									<>
										A credential named <code>{existing.name}</code> already
										exists. Replace it (its package locks stay; its hosts become
										the ones below).
									</>
								)}
							</span>
						</label>
					) : null}
					{kind === 'login' ? (
						renderLoginFields({ state, update })
					) : (
						<div mix={css(fieldCss)}>
							<label for="connect-credential-value" mix={css(fieldLabelCss)}>
								Value
							</label>
							<PasswordRevealInput
								id="connect-credential-value"
								required
								autoFocus={Boolean(state.name)}
								{...passwordManagerIgnoreProps}
								value={state.value}
								placeholder={valuePlaceholder(kind)}
								revealNoun="value"
								revealed={showValue}
								onRevealedChange={(next) => {
									showValue = next
									handle.update()
								}}
								mix={[
									css(inputCss),
									on('input', (event) =>
										update({ value: event.currentTarget.value }),
									),
								]}
							/>
							<span mix={css(mutedCss)}>
								Only Kody sees the value. Agents and package code never do.
							</span>
						</div>
					)}
					<div mix={css(fieldCss)}>
						<label for="connect-credential-hosts" mix={css(fieldLabelCss)}>
							{isKey ? 'Allowed hosts' : 'Hosts'}{' '}
							<span mix={css(labelHintCss)}>(one per line)</span>
						</label>
						<textarea
							id="connect-credential-hosts"
							rows={2}
							required={!isKey}
							value={state.hosts}
							placeholder={
								isKey ? 'api.example.com' : 'api.example.com or *.example.com'
							}
							mix={[
								css(inputCss),
								on('input', (event) =>
									update({ hosts: event.currentTarget.value }),
								),
							]}
						/>
						<span mix={css(mutedCss)}>{hostsHint(kind)}</span>
					</div>
					{kind === 'login' ? renderLoginExchange({ state, update }) : null}
					<div mix={css(fieldCss)}>
						<label for="connect-credential-provider" mix={css(fieldLabelCss)}>
							Provider <span mix={css(labelHintCss)}>(optional)</span>
						</label>
						<input
							id="connect-credential-provider"
							value={state.provider}
							placeholder="openai"
							mix={[
								css(inputCss),
								on('input', (event) =>
									update({ provider: event.currentTarget.value }),
								),
							]}
						/>
					</div>
					<div mix={css(fieldCss)}>
						<label
							for="connect-credential-description"
							mix={css(fieldLabelCss)}
						>
							Description <span mix={css(labelHintCss)}>(optional)</span>
						</label>
						<input
							id="connect-credential-description"
							value={state.description}
							mix={[
								css(inputCss),
								on('input', (event) =>
									update({ description: event.currentTarget.value }),
								),
							]}
						/>
					</div>
					{renderPackageAccess({
						state,
						packages: input.packages,
						packageKeys: isKey,
						update,
					})}
					<div mix={css(fieldCss)}>
						<label for="connect-credential-expires" mix={css(fieldLabelCss)}>
							Expires <span mix={css(labelHintCss)}>(optional)</span>
						</label>
						<input
							id="connect-credential-expires"
							type="date"
							value={expiresAtDateValue(state.expiresAt)}
							mix={[
								css(inputCss),
								on('input', (event) =>
									update({ expiresAt: event.currentTarget.value }),
								),
							]}
						/>
						{expiresAtHasTime(state.expiresAt) ? (
							<span
								mix={css(mutedCss)}
								data-testid="connect-credential-expires-time"
							>
								The link sets {state.expiresAt} (UTC). Pick a date to change it.
							</span>
						) : null}
						{existing?.expiresAt &&
						state.replaceExisting &&
						!state.expiresAt ? (
							<span mix={css(mutedCss)}>
								Leave empty to keep its current expiry.
							</span>
						) : null}
					</div>
					{input.linkProblem ? (
						<p
							mix={css(errorCss)}
							data-testid="connect-credential-link-problem"
						>
							{input.linkProblem}
						</p>
					) : null}
					{message ? (
						<div
							role="alert"
							mix={css({
								display: 'grid',
								gap: spacing.sm,
								justifyItems: 'start',
							})}
						>
							<p mix={css(errorCss)} data-testid="connect-credential-message">
								{message}
							</p>
							<CopyTextButton
								value={input.prompt(message)}
								idleLabel="Copy prompt for your agent"
							/>
						</div>
					) : null}
					<button
						type="submit"
						disabled={
							saving || input.linkProblem !== null || kindConflict !== null
						}
						data-testid="connect-credential-save"
						mix={css(primaryButtonCss)}
					>
						{saving ? 'Saving…' : isKey ? 'Save key' : 'Save credential'}
					</button>
				</form>
			</section>
		)
	}

	return () => {
		const href = readCurrentRouterHref(handle)
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'accountCredentials',
			href,
		)
		if (routeData) data = routeData
		if (!form || formForHref !== credentialCreateFormKey(href)) resetFor(href)
		const state = form as KeyFormState
		const search = new URL(href, 'http://localhost').searchParams
		const query = parseCredentialCreateQuery(search)
		const pathOrgSlug = orgSlugFromPathname(
			new URL(href, 'http://localhost').pathname,
		)
		// After an org switch, the last org's credentials and packages must not
		// drive matches, replace detection, or link problems here.
		if (data && pathOrgSlug && data.orgSlug !== pathOrgSlug) data = null
		const orgSlug = data?.orgSlug ?? ''
		const selected = query.kind ?? 'secret'
		const kinds = query.kindLocked && selected ? [selected] : credentialKinds
		const matches = data ? findMatchingCredentials(data.credentials, query) : []
		const packages = data?.packages ?? []
		const existing = findExistingOrgKey(
			data?.credentials ?? [],
			state.name,
			keyFormPackageId(state, selected),
		)
		const linkProblem = data ? keyLinkProblem({ query, packages }) : null
		const scopedPackage =
			query.packageScopedTo === null || (selected && selected !== 'secret')
				? null
				: (packages.find((entry) => entry.id === query.packageScopedTo) ?? null)
		const pageUrl =
			typeof window === 'undefined'
				? href
				: new URL(href, window.location.origin).toString()

		return (
			<AccountManagementShell>
				<section mix={css(stackedPageCss)} data-testid="connect-credential">
					<header mix={css(pageHeaderCss)}>
						<span mix={css(pageEyebrowCss)}>Add a credential</span>
						<h1 mix={css(pageTitleCss)}>
							{query.kind
								? credentialCreateTitle(query.kind)
								: 'Add a credential'}
						</h1>
						<p mix={css(pageDescriptionCss)}>
							{query.packageKodyId && query.needKey ? (
								<>
									For <code>{query.packageKodyId}</code>, which needs{' '}
									<code>{query.needKey}</code>.{' '}
								</>
							) : null}
							{scopedPackage ? (
								<>
									Only <code>{scopedPackage.kodyId}</code> can read this
									key.{' '}
								</>
							) : null}
							Kody keeps the value and places it on requests for you. It never
							appears to agents or package code.
						</p>
					</header>

					{renderMatches({ matches, orgSlug })}

					<section
						aria-label="Credential kind"
						mix={css({ display: 'grid', gap: spacing.sm })}
					>
						{query.kindLocked && selected ? (
							<p mix={css(mutedCss)}>
								This link asks for a {credentialKindLabel(selected)} credential.
							</p>
						) : (
							<p mix={css(mutedCss)}>
								{query.kind
									? 'Suggested by the link. Pick another kind if it fits better.'
									: 'A key fits most credentials. Pick another kind if it fits better.'}
							</p>
						)}
						{renderKindList({ kinds, selected, href })}
					</section>

					{renderKindBody({
						kind: selected,
						search,
						orgSlug,
						personalOrgSlug: data?.personalOrgSlug ?? null,
						valueForm: (kind) =>
							renderKeyForm({
								kind,
								state,
								existing,
								orgSlug,
								packages,
								linkProblem,
								forNeed:
									pathOrgSlug && query.packageKodyId && query.needKey
										? {
												orgSlug: pathOrgSlug,
												packageKodyId: query.packageKodyId,
												needKey: query.needKey,
											}
										: null,
								prompt: (error) =>
									credentialCreateAgentPrompt({
										kind,
										query,
										pageUrl,
										error,
									}),
							}),
					})}
				</section>
			</AccountManagementShell>
		)
	}
}

function renderKindBody(input: {
	kind: CredentialKind
	search: URLSearchParams
	orgSlug: string
	personalOrgSlug: string | null
	valueForm: (kind: ValueFormKind) => RemixNode
}) {
	const mode = credentialCreateMode(input.kind)
	switch (mode) {
		case 'value-form':
			return isValueFormKind(input.kind) ? input.valueForm(input.kind) : null
		case 'handoff': {
			const kind = input.kind === 'oauth' ? 'oauth' : 'mcp'
			const provider = input.search.get('provider')?.trim()
			return (
				<section mix={css(cardCss)} data-testid="connect-credential-handoff">
					<p mix={css({ margin: 0 })}>
						{kind === 'oauth'
							? `Kody sends you to ${provider ? `${provider}'s` : 'the provider’s'} sign-in, then brings you back.`
							: 'Add the server’s URL. Kody connects to it and asks you to sign in when the server needs it.'}
					</p>
					{kind === 'oauth' &&
					input.personalOrgSlug &&
					input.orgSlug &&
					input.personalOrgSlug !== input.orgSlug ? (
						<p
							mix={css(mutedCss)}
							data-testid="connect-credential-oauth-personal"
						>
							Kody saves OAuth connections to your personal account,{' '}
							<code>@{input.personalOrgSlug}</code>, not to this team.
						</p>
					) : null}
					<a
						href={credentialCreateHandoffHref({
							kind,
							search: input.search,
							orgSlug: input.orgSlug,
						})}
						mix={css(primaryButtonCss)}
						data-testid="connect-credential-continue"
					>
						{kind === 'oauth'
							? 'Continue to connect'
							: 'Continue to add server'}
					</a>
				</section>
			)
		}
		default: {
			const exhaustive: never = mode
			return exhaustive
		}
	}
}
