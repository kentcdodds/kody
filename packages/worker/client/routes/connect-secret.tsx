import { type Handle } from 'remix/component'
import { navigate } from '#client/client-router.tsx'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#client/styles/tokens.ts'
import { SecretEditorFields } from './secret-editor-fields.tsx'
import {
	normalizeAllowedCapabilities,
	normalizeAllowedHosts,
} from './secret-normalization.ts'
import { formatConnectorConfigFailureMessage } from './connect-secret-errors.ts'

type StorageScope = 'app' | 'session' | 'user'
type ViewStep =
	| 'loading'
	| 'input'
	| 'review'
	| 'saving'
	| 'success'
	| 'error'
	| 'update-confirm'
	| 'cancelled'

type SecretMetadata = {
	name: string
	scope: StorageScope
	description: string
	allowed_hosts: Array<string>
	allowed_capabilities: Array<string>
	created_at: string
	updated_at: string
	ttl_ms: number | null
}

type ConnectSecretParams = {
	name: string
	description: string
	allowedHosts: Array<string>
	allowedCapabilities: Array<string>
	scope: StorageScope
	dashboardUrl: string
	instructions: string
	connector: string
}

type ConnectSecretState = {
	step: ViewStep
	error: string
	description: string
	secretValue: string
	allowedHosts: Array<string>
	allowedCapabilities: Array<string>
	showSecretValue: boolean
	existingSecret: SecretMetadata | null
	confirmedReview: boolean
}

type ConnectSecretSession = {
	token: string
	endpoints: {
		secrets: string
		deleteSecret: string
		execute: string
		source: string
	}
}

const defaultState: ConnectSecretState = {
	step: 'loading',
	error: '',
	description: '',
	secretValue: '',
	allowedHosts: [''],
	allowedCapabilities: [''],
	showSecretValue: false,
	existingSecret: null,
	confirmedReview: false,
}

function getSearchParams() {
	return typeof window === 'undefined'
		? new URLSearchParams()
		: new URLSearchParams(window.location.search)
}

function parseScope(value: string | null): StorageScope {
	return value === 'app' || value === 'session' || value === 'user'
		? value
		: 'user'
}

function parseCommaList(
	value: string | null,
	normalizer?: (item: string) => string,
) {
	if (!value) return []
	const output = value
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
	return Array.from(new Set(output.map((item) => normalizer?.(item) ?? item)))
}

function parseConnectSecretParams(): ConnectSecretParams {
	const params = getSearchParams()
	const name = params.get('name')?.trim() ?? ''
	const description = params.get('description')?.trim() ?? ''
	const instructions = params.get('instructions')?.trim() ?? ''
	const dashboardUrl = params.get('dashboardUrl')?.trim() ?? ''
	const connector = params.get('connector')?.trim() ?? ''
	const scope = parseScope(params.get('scope'))
	const allowedHosts = parseCommaList(params.get('allowedHosts'), (value) =>
		value.toLowerCase(),
	).sort()
	const allowedCapabilities = parseCommaList(
		params.get('allowedCapabilities'),
	).sort((left, right) => left.localeCompare(right))
	return {
		name,
		description,
		allowedHosts,
		allowedCapabilities,
		scope,
		dashboardUrl,
		instructions,
		connector,
	}
}

function toEditableRows(values: Array<string> | null | undefined) {
	if (!Array.isArray(values) || values.length === 0) return ['']
	return [...values]
}

function createInitialConnectSecretState(
	params: ConnectSecretParams,
): ConnectSecretState {
	return {
		...defaultState,
		description: params.description,
		allowedHosts: toEditableRows(params.allowedHosts),
		allowedCapabilities: toEditableRows(params.allowedCapabilities),
	}
}

function scopeLabel(scope: StorageScope) {
	if (scope === 'session') return 'Session (expires when this session ends)'
	if (scope === 'app') return 'App'
	return 'User'
}

function isSafeUrl(value: string) {
	if (!value) return false
	try {
		const parsed = new URL(value)
		return parsed.protocol === 'https:' || parsed.protocol === 'http:'
	} catch {
		return false
	}
}

async function readSessionToken() {
	const url = new URL('/connect/secret.json', window.location.href)
	url.search = window.location.search
	const response = await fetch(url.toString(), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
	})
	if (response.status === 401) {
		navigate(
			`/login?redirectTo=${encodeURIComponent(window.location.pathname + window.location.search)}`,
		)
		return null
	}
	const payload = (await response.json().catch(() => null)) as {
		ok?: boolean
		appSession?: ConnectSecretSession
		error?: string
	}
	if (!response.ok || !payload?.ok || !payload.appSession?.token) {
		throw new Error(payload?.error || 'Unable to load secret session.')
	}
	return payload.appSession
}

function isSessionRefreshError(error: unknown) {
	return (
		error instanceof Error &&
		(error.message.includes('Generated UI session has expired.') ||
			error.message.includes('Invalid session token.') ||
			error.message.includes('User mismatch.'))
	)
}

async function listExistingSecret(
	params: ConnectSecretParams,
	session: ConnectSecretSession,
): Promise<SecretMetadata | null> {
	const url = new URL(session.endpoints.secrets)
	url.searchParams.set('scope', params.scope)
	const response = await fetch(url.toString(), {
		headers: {
			Accept: 'application/json',
			Authorization: `Bearer ${session.token}`,
		},
		credentials: 'omit',
	})
	const payload = (await response.json().catch(() => null)) as {
		ok?: boolean
		secrets?: Array<SecretMetadata>
		error?: string
	}
	if (!response.ok) {
		throw new Error(payload?.error || 'Unable to load existing secrets.')
	}
	if (!payload?.ok || !Array.isArray(payload.secrets)) {
		return null
	}
	return (
		payload.secrets.find(
			(secret) => secret.name === params.name && secret.scope === params.scope,
		) ?? null
	)
}

async function saveSecretValue(
	params: ConnectSecretParams,
	session: ConnectSecretSession,
	input: {
		value: string
		description: string
		allowedHosts: Array<string>
		allowedCapabilities: Array<string>
	},
) {
	const response = await fetch('/connect/secret.json', {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify({
			name: params.name,
			scope: params.scope,
			sessionToken: session.token,
			value: input.value,
			description: input.description,
			allowedHosts: input.allowedHosts,
			allowedCapabilities: input.allowedCapabilities,
		}),
	})
	const payload = (await response.json().catch(() => null)) as {
		ok?: boolean
		error?: string
	}
	if (!response.ok || !payload?.ok) {
		throw new Error(payload?.error || 'Unable to save secret.')
	}
}

async function updateConnectorConfig(
	params: ConnectSecretParams,
	session: ConnectSecretSession,
	input: {
		allowedHosts: Array<string>
		allowedCapabilities: Array<string>
	},
) {
	if (!params.connector) return
	const response = await fetch('/connect/secret.json', {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify({
			name: params.name,
			scope: params.scope,
			sessionToken: session.token,
			connector: params.connector,
			allowedHosts: input.allowedHosts,
			allowedCapabilities: input.allowedCapabilities,
		}),
	})
	const payload = (await response.json().catch(() => null)) as {
		ok?: boolean
		error?: string
	}
	if (!response.ok || !payload?.ok) {
		throw new Error(payload?.error || 'Unable to update connector config.')
	}
}

async function rollbackSecretValue(
	params: ConnectSecretParams,
	session: ConnectSecretSession,
) {
	const response = await fetch(session.endpoints.deleteSecret, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			Authorization: `Bearer ${session.token}`,
		},
		credentials: 'omit',
		body: JSON.stringify({
			name: params.name,
			scope: params.scope,
		}),
	})
	const payload = (await response.json().catch(() => null)) as {
		ok?: boolean
		error?: string
	}
	if (!response.ok || !payload?.ok) {
		throw new Error(payload?.error || 'Unable to rollback secret.')
	}
}

export function ConnectSecretRoute(handle: Handle) {
	let state = { ...defaultState }
	let session: ConnectSecretSession | null = null
	let lastSearch: string | null = null
	let initVersion = 0

	function setState(next: Partial<ConnectSecretState>) {
		state = { ...state, ...next }
		handle.update()
	}

	function startInitialization() {
		session = null
		initVersion += 1
		const version = initVersion
		setState({ ...defaultState, step: 'loading' })
		handle.queueTask(() => initialize(version))
	}

	async function initialize(version: number) {
		const params = parseConnectSecretParams()
		if (!params.name) {
			if (version !== initVersion) return
			setState({
				step: 'error',
				error: 'Provide a name query parameter to continue.',
			})
			return
		}
		try {
			const nextSession = await readSessionToken()
			if (version !== initVersion || !nextSession) return
			session = nextSession
			const existing = await listExistingSecret(params, nextSession)
			if (version !== initVersion) return
			if (existing) {
				setState({
					...createInitialConnectSecretState(params),
					step: 'update-confirm',
					existingSecret: existing,
					description: existing.description,
					allowedHosts: toEditableRows(existing.allowed_hosts),
					allowedCapabilities: toEditableRows(existing.allowed_capabilities),
				})
				return
			}
			setState({
				...createInitialConnectSecretState(params),
				step: 'input',
			})
		} catch (error) {
			if (version !== initVersion) return
			if (isSessionRefreshError(error)) {
				startInitialization()
				return
			}
			setState({
				step: 'error',
				error:
					error instanceof Error ? error.message : 'Unable to load secrets.',
			})
		}
	}

	async function handleSave() {
		if (state.step === 'saving') return
		if (!session) {
			setState({
				step: 'error',
				error: 'Missing session token. Refresh and retry.',
			})
			return
		}
		const params = parseConnectSecretParams()
		const normalizedAllowedHosts = normalizeAllowedHosts(state.allowedHosts)
		const normalizedAllowedCapabilities = normalizeAllowedCapabilities(
			state.allowedCapabilities,
		)
		if (!state.secretValue.trim()) {
			setState({
				step: 'error',
				error: 'Enter the secret value before continuing.',
			})
			return
		}
		setState({ step: 'saving', error: '' })
		try {
			await saveSecretValue(params, session, {
				value: state.secretValue,
				description: state.description,
				allowedHosts: normalizedAllowedHosts,
				allowedCapabilities: normalizedAllowedCapabilities,
			})
		} catch (error) {
			if (isSessionRefreshError(error)) {
				startInitialization()
				return
			}
			setState({
				step: 'error',
				error:
					error instanceof Error ? error.message : 'Unable to save secret.',
			})
			return
		}
		try {
			await updateConnectorConfig(params, session, {
				allowedHosts: normalizedAllowedHosts,
				allowedCapabilities: normalizedAllowedCapabilities,
			})
			setState({ step: 'success' })
		} catch (error) {
			const secretWasNewlyCreated = state.existingSecret == null
			if (params.connector && secretWasNewlyCreated) {
				try {
					await rollbackSecretValue(params, session)
				} catch (rollbackError) {
					const rollbackMessage =
						rollbackError instanceof Error
							? rollbackError.message
							: 'Unable to rollback secret.'
					const originalMessage =
						error instanceof Error
							? error.message
							: 'Unable to update connector config.'
					setState({
						step: 'error',
						error: `Connector configuration failed and rollback did not complete. ${originalMessage} ${rollbackMessage}`,
					})
					return
				}
			}
			setState({
				step: 'error',
				error: formatConnectorConfigFailureMessage(error, {
					secretRolledBack: Boolean(params.connector && secretWasNewlyCreated),
					updatedSecretRetained: Boolean(
						params.connector && !secretWasNewlyCreated,
					),
				}),
			})
		}
	}

	function handleErrorBack() {
		if (!session || state.error.includes('session')) {
			startInitialization()
			return
		}
		setState({ step: 'input', error: '' })
	}

	function updateAllowedHost(index: number, value: string) {
		setState({
			allowedHosts: state.allowedHosts.map((host, hostIndex) =>
				hostIndex === index ? value : host,
			),
		})
	}

	function addAllowedHost() {
		setState({
			allowedHosts: [...state.allowedHosts, ''],
		})
	}

	function removeAllowedHost(index: number) {
		const nextHosts = state.allowedHosts.filter(
			(_host, hostIndex) => hostIndex !== index,
		)
		setState({
			allowedHosts: nextHosts.length > 0 ? nextHosts : [''],
		})
	}

	function updateAllowedCapability(index: number, value: string) {
		setState({
			allowedCapabilities: state.allowedCapabilities.map(
				(capability, capabilityIndex) =>
					capabilityIndex === index ? value : capability,
			),
		})
	}

	function addAllowedCapability() {
		setState({
			allowedCapabilities: [...state.allowedCapabilities, ''],
		})
	}

	function removeAllowedCapability(index: number) {
		const nextCapabilities = state.allowedCapabilities.filter(
			(_capability, capabilityIndex) => capabilityIndex !== index,
		)
		setState({
			allowedCapabilities: nextCapabilities.length > 0 ? nextCapabilities : [''],
		})
	}

	return () => {
		const currentSearch =
			typeof window === 'undefined' ? '' : window.location.search
		if (currentSearch !== lastSearch) {
			lastSearch = currentSearch
			// Defer: startInitialization calls handle.update(), which must not run during
			// render (Remix component runtime throws "scheduleUpdate not implemented").
			handle.queueTask(() => {
				startInitialization()
			})
		}

		const params = parseConnectSecretParams()
		const hasInstructions = Boolean(params.instructions || params.dashboardUrl)
		const showReview = state.step === 'review' || state.step === 'saving'
		const normalizedAllowedHosts = normalizeAllowedHosts(state.allowedHosts)
		const normalizedAllowedCapabilities = normalizeAllowedCapabilities(
			state.allowedCapabilities,
		)

		return (
			<section
				css={{
					maxWidth: '46rem',
					margin: '0 auto',
					display: 'grid',
					gap: spacing.lg,
				}}
			>
				<header css={{ display: 'grid', gap: spacing.xs }}>
					<span
						css={{
							fontSize: typography.fontSize.xs,
							letterSpacing: '0.12em',
							textTransform: 'uppercase',
							color: colors.textMuted,
						}}
					>
						Kody secure connection
					</span>
					<h1
						css={{
							margin: 0,
							fontSize: typography.fontSize.xl,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
						}}
					>
						Save a secret
					</h1>
					<p css={{ margin: 0, color: colors.textMuted }}>
						{params.description ||
							'This keeps credentials private and out of chat logs.'}
					</p>
				</header>

				{state.step === 'loading' ? (
					<p css={{ color: colors.textMuted }}>Loading secret details…</p>
				) : null}

				{state.step === 'update-confirm' && state.existingSecret ? (
					<section css={cardCss}>
						<h2 css={cardTitleCss}>Secret already exists</h2>
						<p css={{ margin: 0, color: colors.textMuted }}>
							A secret named <strong>{state.existingSecret.name}</strong>{' '}
							already exists in the {state.existingSecret.scope} scope. Updating
							will replace the stored value.
						</p>
						<div
							css={{
								display: 'grid',
								gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
								gap: spacing.md,
							}}
						>
							<div>
								<div css={labelCss}>Current allowed hosts</div>
								<ul css={listCss}>
									{state.existingSecret.allowed_hosts.length > 0 ? (
										state.existingSecret.allowed_hosts.map((host) => (
											<li key={host}>{host}</li>
										))
									) : (
										<li>None</li>
									)}
								</ul>
							</div>
							<div>
								<div css={labelCss}>Current allowed capabilities</div>
								<ul css={listCss}>
									{state.existingSecret.allowed_capabilities.length > 0 ? (
										state.existingSecret.allowed_capabilities.map((cap) => (
											<li key={cap}>{cap}</li>
										))
									) : (
										<li>None</li>
									)}
								</ul>
							</div>
						</div>
						<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
							<button
								type="button"
								css={primaryButtonCss}
								on={{
									click: () => setState({ step: 'input' }),
								}}
							>
								Update secret
							</button>
							<button
								type="button"
								css={secondaryButtonCss}
								on={{ click: () => setState({ step: 'cancelled' }) }}
							>
								Cancel
							</button>
						</div>
					</section>
				) : null}

				{state.step === 'cancelled' ? (
					<section css={cardCss}>
						<h2 css={cardTitleCss}>Cancelled</h2>
						<p css={{ margin: 0, color: colors.textMuted }}>
							No changes were made. You can close this tab.
						</p>
					</section>
				) : null}

				{state.step === 'success' ? (
					<section css={cardCss}>
						<h2 css={cardTitleCss}>Secret saved</h2>
						<p css={{ margin: 0, color: colors.textMuted }}>
							You can close this tab now.
						</p>
					</section>
				) : null}

				{state.step === 'error' ? (
					<section css={cardCss}>
						<h2 css={cardTitleCss}>Something went wrong</h2>
						<p css={{ margin: 0, color: colors.textMuted }}>{state.error}</p>
						<button
							type="button"
							css={secondaryButtonCss}
							on={{ click: () => handleErrorBack() }}
						>
							Back
						</button>
					</section>
				) : null}

				{['input', 'review', 'saving'].includes(state.step) ? (
					<>
						<section css={cardCss}>
							<h2 css={cardTitleCss}>Instructions</h2>
							{hasInstructions ? (
								<>
									{params.instructions ? (
										<p css={{ margin: 0, color: colors.text }}>
											{params.instructions}
										</p>
									) : null}
									{params.dashboardUrl && isSafeUrl(params.dashboardUrl) ? (
										<a
											href={params.dashboardUrl}
											target="_blank"
											rel="noreferrer"
										>
											Open provider settings
										</a>
									) : null}
									{params.dashboardUrl && !isSafeUrl(params.dashboardUrl) ? (
										<p css={{ margin: 0, color: colors.textMuted }}>
											The provided dashboard link is invalid.
										</p>
									) : null}
								</>
							) : (
								<p css={{ margin: 0, color: colors.textMuted }}>
									Enter the secret value below.
								</p>
							)}
						</section>

						<section css={cardCss}>
							<h2 css={cardTitleCss}>Enter secret</h2>
							<SecretEditorFields
								description={state.description}
								onDescriptionChange={(description) => setState({ description })}
								value={state.secretValue}
								onValueChange={(secretValue) => setState({ secretValue })}
								showSecretValue={state.showSecretValue}
								onToggleShowSecretValue={() =>
									setState({ showSecretValue: !state.showSecretValue })
								}
								allowedHosts={state.allowedHosts}
								onUpdateAllowedHost={updateAllowedHost}
								onAddAllowedHost={addAllowedHost}
								onRemoveAllowedHost={removeAllowedHost}
								allowedCapabilities={state.allowedCapabilities}
								onUpdateAllowedCapability={updateAllowedCapability}
								onAddAllowedCapability={addAllowedCapability}
								onRemoveAllowedCapability={removeAllowedCapability}
								valuePlaceholder="Paste the secret value"
							/>
						</section>

						{showReview ? (
							<section css={cardCss}>
								<h2 css={cardTitleCss}>Review before saving</h2>
								<div
									css={{
										display: 'grid',
										gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
										gap: spacing.md,
									}}
								>
									<div>
										<div css={labelCss}>Secret name</div>
										<div>{params.name}</div>
									</div>
									<div>
										<div css={labelCss}>Scope</div>
										<div>{scopeLabel(params.scope)}</div>
									</div>
									{state.description ? (
										<div css={{ gridColumn: '1 / -1' }}>
											<div css={labelCss}>Description</div>
											<div>{state.description}</div>
										</div>
									) : null}
								</div>
								<div
									css={{
										display: 'grid',
										gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
										gap: spacing.md,
									}}
								>
									<div>
										<div css={labelCss}>Hosts to approve</div>
										<ul css={listCss}>
											{normalizedAllowedHosts.length > 0 ? (
												normalizedAllowedHosts.map((host) => (
													<li key={host}>{host}</li>
												))
											) : (
												<li>None (approval required later).</li>
											)}
										</ul>
									</div>
									<div>
										<div css={labelCss}>Capabilities to allow</div>
										<ul css={listCss}>
											{normalizedAllowedCapabilities.length > 0 ? (
												normalizedAllowedCapabilities.map((capability) => (
													<li key={capability}>{capability}</li>
												))
											) : (
												<li>No restrictions requested.</li>
											)}
										</ul>
									</div>
								</div>
								<p css={{ margin: 0, color: colors.textMuted }}>
									Host and capability approvals are managed in account settings.
								</p>
								<p css={{ margin: 0, color: colors.textMuted }}>
									The secret value stays hidden and cannot be viewed later.
								</p>
							</section>
						) : null}

						{showReview ? (
							<label
								css={{
									display: 'flex',
									gap: spacing.xs,
									alignItems: 'center',
								}}
							>
								<input
									type="checkbox"
									checked={state.confirmedReview}
									on={{
										change: (event) =>
											setState({
												confirmedReview: event.currentTarget.checked,
											}),
									}}
								/>
								I confirm these details are correct.
							</label>
						) : null}

						{state.step === 'saving' ? (
							<p css={{ color: colors.textMuted }}>Saving secret…</p>
						) : null}

						<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
							{showReview ? (
								<>
									<button
										type="button"
										css={secondaryButtonCss}
										disabled={state.step === 'saving'}
										on={{
											click: () =>
												setState({ step: 'input', confirmedReview: false }),
										}}
									>
										Back
									</button>
									<button
										type="button"
										css={primaryButtonCss}
										disabled={state.step === 'saving' || !state.confirmedReview}
										on={{ click: () => void handleSave() }}
									>
										Save secret
									</button>
								</>
							) : (
								<button
									type="button"
									css={primaryButtonCss}
									on={{
										click: () =>
											setState(
												state.secretValue.trim()
													? { step: 'review', confirmedReview: false }
													: {
															step: 'error',
															error:
																'Enter the secret value before continuing.',
														},
											),
									}}
								>
									Review
								</button>
							)}
						</div>
					</>
				) : null}
			</section>
		)
	}
}

const cardCss = {
	padding: spacing.lg,
	borderRadius: radius.lg,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	boxShadow: shadows.sm,
	display: 'grid',
	gap: spacing.sm,
}

const cardTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const labelCss = {
	fontWeight: typography.fontWeight.medium,
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const listCss = {
	margin: 0,
	paddingLeft: spacing.lg,
	display: 'grid',
	gap: spacing.xs,
	color: colors.text,
}

const primaryButtonCss = {
	padding: `${spacing.sm} ${spacing.lg}`,
	borderRadius: radius.full,
	border: 'none',
	backgroundColor: colors.primary,
	color: colors.onPrimary,
	fontWeight: typography.fontWeight.semibold,
	cursor: 'pointer',
}

const secondaryButtonCss = {
	...primaryButtonCss,
	backgroundColor: 'transparent',
	color: colors.text,
	border: `1px solid ${colors.border}`,
}
