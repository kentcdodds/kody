import { type Handle, css } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import { type AccountStatus } from '#client/routes/account-approval-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import { RecordTable, recordCellClamp } from '#client/routes/record-table.tsx'
import {
	buildPackageWebhooksHref,
	fetchAccountWebhooks,
	webhookModeLabel,
	webhookStatusColor,
	webhookStatusLabel,
	webhookVerificationLabel,
	webhooksDocHref,
} from '#client/routes/webhooks-shared.ts'
import {
	type AccountWebhooksLoaderData,
	type PackageWebhookListItem,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { primaryLinkCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'

const clampedCellCss = css(recordCellClamp(28))

const listPath = routes.accountWebhooks.href()

/** The index shares one payload regardless of query string. */
function getWebhooksDataLatchKey(_href: string) {
	return listPath
}

/**
 * `/account/webhooks` — a thin cross-package index. Each row deep-links into
 * the owning package's settings, where the owner mints, reveals, copies,
 * rotates, and disables the URL. Nothing here carries or mutates a credential.
 */
export function AccountWebhooksRoute(handle: Handle) {
	let username = ''
	let webhooks: Array<PackageWebhookListItem> = []
	/** Payload last applied to the closure state above. */
	let appliedPayload: AccountWebhooksLoaderData | null = null
	const webhooksData = createRouteData({
		key: 'accountWebhooks',
		locationKey: getWebhooksDataLatchKey,
		async load(_href, signal) {
			const result = await fetchAccountWebhooks(signal)
			if (result.kind === 'unauthorized') return routeDataRedirect('/login')
			return result.payload
		},
	})

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = webhooksData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedPayload) {
			appliedPayload = snapshot.data
			username = snapshot.data.username
			webhooks = snapshot.data.webhooks
		}
		const pending = snapshot.kind === 'pending'
		const status: AccountStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && appliedPayload === null
					? 'loading'
					: 'ready'
		const mintedCount = webhooks.filter((webhook) => webhook.minted).length

		return (
			<AccountManagementShell busy={pending && appliedPayload !== null}>
				<AccountPageHeader
					title="Webhooks"
					description="Every inbound webhook your packages declare, in one list. Webhooks belong to the package that declares them, so open a row to mint, reveal, copy, rotate, or disable its URL in that package's settings."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading webhooks…
					</p>
				) : null}
				{snapshot.error ? (
					<AccountManagementMessage tone="error">
						{snapshot.error.message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' ? (
					<RecordTable
						mode="none"
						ariaLabel="Webhooks"
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
							href: buildPackageWebhooksHref({
								username,
								kodyId: webhook.packageKodyId,
								webhookName: webhook.name,
							}),
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
					/>
				) : null}

				{status === 'ready' ? (
					<p
						mix={css({ color: colors.textMuted, margin: `${spacing.md} 0 0` })}
					>
						Webhooks are declared in <code>package.json#kody.webhooks</code>;
						each name binds one export and its URL is managed from the owning
						package's settings.{' '}
						<a href={webhooksDocHref} mix={css(primaryLinkCss)}>
							Inbound webhooks docs
						</a>
					</p>
				) : null}
			</AccountManagementShell>
		)
	}
}
