import { type Handle, css } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createDoubleCheck } from '#client/double-check.ts'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import {
	renderAccountWebhookDetail,
	renderWebhookDetailPlaceholder,
	type WebhookIntent,
} from '#client/routes/account-webhooks-detail.tsx'
import {
	accountWebhooksApiPath,
	buildWebhookDetailHref,
	fetchAccountWebhooks,
	getWebhooksDataLatchKey,
	readWebhookSelection,
	webhookModeLabel,
	webhookStatusColor,
	webhookStatusLabel,
	webhookVerificationLabel,
	webhooksDocHref,
} from '#client/routes/account-webhooks-shared.ts'
import { RecordTable, recordCellClamp } from '#client/routes/record-table.tsx'
import {
	type AccountWebhookListItem,
	type AccountWebhooksActionPayload,
	type AccountWebhooksLoaderData,
} from '#universal/loader-data.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { primaryLinkCss } from '#universal/styles/style-primitives.ts'

const clampedCellCss = css(recordCellClamp(28))

type MessageTone = 'info' | 'error'

function successMessageFor(intent: WebhookIntent) {
	switch (intent) {
		case 'mint':
			return 'Webhook URL minted. Copy it now and paste it into the provider.'
		case 'rotate':
			return 'Webhook URL rotated. The previous URL no longer works.'
		case 'reveal':
			return null
		case 'enable':
			return 'Webhook enabled.'
		case 'disable':
			return 'Webhook disabled. Deliveries now answer 404.'
		default: {
			const exhaustive: never = intent
			return String(exhaustive)
		}
	}
}

function failureMessageFor(intent: WebhookIntent) {
	switch (intent) {
		case 'mint':
			return 'Unable to mint the webhook URL.'
		case 'rotate':
			return 'Unable to rotate the webhook URL.'
		case 'reveal':
			return 'Unable to reveal the webhook URL.'
		case 'enable':
			return 'Unable to enable the webhook.'
		case 'disable':
			return 'Unable to disable the webhook.'
		default: {
			const exhaustive: never = intent
			return String(exhaustive)
		}
	}
}

/**
 * `/account/webhooks` — the owner's home for minted webhook URLs. The list
 * payload never carries the credential; Reveal (and the reveal that rides
 * along with Mint / Rotate) fetches it per webhook and keeps it in memory
 * until the owner hides it or moves to another row.
 */
export function AccountWebhooksRoute(handle: Handle) {
	let actionState: 'idle' | 'busy' = 'idle'
	let username = ''
	let webhooks: Array<AccountWebhookListItem> = []
	let message: string | null = null
	let messageTone: MessageTone = 'info'
	/** Revealed credential URLs keyed by row id; never part of the payload. */
	const revealedUrls = new Map<string, string>()
	/** Payload last applied to the closure state above. */
	let appliedPayload: AccountWebhooksLoaderData | null = null
	let appliedError: Error | null = null
	const rotateCheck = createDoubleCheck(handle)
	const disableCheck = createDoubleCheck(handle)
	const webhooksData = createRouteData({
		key: 'accountWebhooks',
		locationKey: getWebhooksDataLatchKey,
		async load(_href, signal) {
			const result = await fetchAccountWebhooks(signal)
			if (result.kind === 'unauthorized') return routeDataRedirect('/login')
			return result.payload
		},
	})

	function setMessage(nextMessage: string | null, tone: MessageTone = 'info') {
		message = nextMessage
		messageTone = tone
	}

	function applyPayload(payload: AccountWebhooksLoaderData) {
		username = payload.username
		webhooks = payload.webhooks
		rotateCheck.reset()
		disableCheck.reset()
	}

	function resetChecks() {
		rotateCheck.reset()
		disableCheck.reset()
	}

	async function postIntent(
		intent: WebhookIntent,
		webhook: AccountWebhookListItem,
	) {
		if (actionState !== 'idle') return
		actionState = 'busy'
		setMessage(null)
		handle.update()
		try {
			const response = await fetch(accountWebhooksApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					intent,
					packageKodyId: webhook.packageKodyId,
					webhookName: webhook.name,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountWebhooksActionPayload & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || failureMessageFor(intent))
			}
			applyPayload(payload)
			if (intent === 'rotate') revealedUrls.delete(webhook.id)
			if (payload.revealed) {
				revealedUrls.set(payload.revealed.id, payload.revealed.url)
			}
			actionState = 'idle'
			setMessage(successMessageFor(intent))
			handle.update()
		} catch (error) {
			actionState = 'idle'
			setMessage(
				error instanceof Error ? error.message : failureMessageFor(intent),
				'error',
			)
			handle.update()
		}
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = webhooksData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedPayload) {
			appliedPayload = snapshot.data
			applyPayload(snapshot.data)
			if (messageTone === 'error') setMessage(null)
		}
		if (snapshot.error && snapshot.error !== appliedError) {
			appliedError = snapshot.error
			setMessage(snapshot.error.message, 'error')
		}
		const pending = snapshot.kind === 'pending'
		const status: AccountStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && appliedPayload === null
					? 'loading'
					: 'ready'
		const isMutating = actionState !== 'idle'
		const selectedId = readWebhookSelection(currentHref)
		const selected =
			selectedId == null
				? null
				: (webhooks.find((webhook) => webhook.id === selectedId) ?? null)
		const showNotFound =
			selectedId != null && selected == null && status === 'ready' && !pending
		const mintedCount = webhooks.filter((webhook) => webhook.minted).length

		return (
			<AccountManagementShell busy={pending && appliedPayload !== null}>
				<AccountPageHeader
					title="Webhooks"
					description="Inbound webhook URLs declared by your packages. Mint a URL here, copy it into the provider that will POST to it, and rotate or disable it when it leaks or goes unused. Agents connected over MCP can mint and apply handles but never see these URLs."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading webhooks…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={
							status === 'error' || messageTone === 'error' ? 'error' : 'info'
						}
					>
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' ? (
					<RecordTable
						mode="expand"
						ariaLabel="Webhooks"
						selectedId={selectedId}
						recordLoading={false}
						onNavigate={() => {
							resetChecks()
							revealedUrls.clear()
							setMessage(null)
						}}
						countLabel={`${webhooks.length} declared · ${mintedCount} minted`}
						emptyLabel="No package on this account declares a webhook yet. Add a kody.webhooks entry to a package manifest and publish it."
						columns={[
							{ key: 'name', label: 'Webhook', primary: true },
							{ key: 'package', label: 'Package' },
							{ key: 'status', label: 'Status' },
							{ key: 'mode', label: 'Mode', drop: 2 },
							{ key: 'verification', label: 'Verification', drop: 1 },
						]}
						rows={webhooks.map((webhook) => ({
							id: webhook.id,
							href: isMutating ? undefined : buildWebhookDetailHref(webhook),
							cells: {
								name: <span mix={clampedCellCss}>{webhook.name}</span>,
								package: (
									<span mix={clampedCellCss}>{webhook.packageName}</span>
								),
								status: (
									<span mix={css({ color: webhookStatusColor(webhook) })}>
										{webhookStatusLabel(webhook)}
									</span>
								),
								mode: (
									<span mix={clampedCellCss}>{webhookModeLabel(webhook)}</span>
								),
								verification: (
									<span mix={clampedCellCss}>
										{webhookVerificationLabel(webhook)}
									</span>
								),
							},
						}))}
						record={
							selected
								? renderAccountWebhookDetail({
										username,
										webhook: selected,
										revealedUrl: revealedUrls.get(selected.id) ?? null,
										isMutating,
										rotateCheck,
										disableCheck,
										onIntent: (intent) => {
											void postIntent(intent, selected)
										},
										onHideUrl: () => {
											revealedUrls.delete(selected.id)
											handle.update()
										},
									})
								: showNotFound
									? renderWebhookDetailPlaceholder(
											'Webhook not found',
											'No package on this account declares this webhook, or it was renamed away.',
										)
									: null
						}
					/>
				) : null}

				{status === 'ready' ? (
					<p
						mix={css({ color: colors.textMuted, margin: `${spacing.md} 0 0` })}
					>
						Webhooks are declared in <code>package.json#kody.webhooks</code>;
						each name binds one export.{' '}
						<a href={webhooksDocHref} mix={css(primaryLinkCss)}>
							Inbound webhooks docs
						</a>
					</p>
				) : null}
			</AccountManagementShell>
		)
	}
}
