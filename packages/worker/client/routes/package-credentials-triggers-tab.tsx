import { type RemixNode, css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import {
	canEditTrigger,
	triggerMappingRows,
} from '#client/routes/package-credentials-editing.ts'
import { accountDisclosureCss } from '#client/routes/account-management-components.tsx'
import {
	type CredentialMappingTarget,
	type PackageTriggerInstanceView,
	type PackageTriggerView,
	buildCredentialApprovalHref,
} from '#universal/credential-contracts.ts'
import {
	canToggleTriggerEnablement,
	describeTrigger,
	triggerEnablementStateLabel,
	triggerStateLabel,
	withheldTriggerMappingsNote,
} from '#universal/package-credentials-page.ts'
import {
	cardCss,
	cardTitleCss,
	getSecondaryButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	type PackageTabContext,
	mutedCss,
	renderEffective,
	renderIncomplete,
	renderMappingCell,
	renderStatus,
	rowCss,
	tabBodyCss,
	tableCss,
} from './package-credentials-tabs.tsx'

const secondaryButtonCss = getSecondaryButtonCss({ weight: 'semibold' })

const switchTrackCss = {
	appearance: 'none' as const,
	width: '2.75rem',
	height: '1.55rem',
	minWidth: '2.75rem',
	borderRadius: radius.full,
	border: `1px solid ${colors.border}`,
	background: colors.surface,
	position: 'relative' as const,
	cursor: 'pointer',
	flexShrink: 0,
	transition: 'background-color 120ms ease, border-color 120ms ease',
	'&::after': {
		content: '""',
		position: 'absolute' as const,
		top: '0.15rem',
		left: '0.15rem',
		width: '1.15rem',
		height: '1.15rem',
		borderRadius: radius.full,
		background: colors.textMuted,
		transition: 'transform 120ms ease, background-color 120ms ease',
	},
	'&[aria-checked="true"]': {
		background: colors.primarySoft,
		borderColor: colors.primary,
	},
	'&[aria-checked="true"]::after': {
		transform: 'translateX(1.15rem)',
		background: colors.primary,
	},
	'&:disabled': {
		opacity: 0.55,
		cursor: 'not-allowed',
	},
	'@media (prefers-reduced-motion: reduce)': {
		transition: 'none',
		'&::after': { transition: 'none' },
	},
}

function renderTriggerMappings(
	context: PackageTabContext,
	trigger: PackageTriggerView,
	instance: PackageTriggerInstanceView | null,
	options: { createInstance?: boolean } = {},
) {
	const withheld = withheldTriggerMappingsNote(trigger)
	if (withheld) return <p mix={css(mutedCss)}>{withheld}</p>
	if (trigger.trigger.kind === 'webhook' && trigger.instanceId === null) {
		return (
			<p mix={css(mutedCss)}>
				{context.view.package.canManage
					? 'This webhook has no URL yet. Once someone mints it from Settings, its runs use their default mappings.'
					: 'This webhook has no URL yet. Once someone who manages this package mints it, its runs use their default mappings.'}
			</p>
		)
	}
	const editable =
		Boolean(context.renderMappingCell) &&
		(options.createInstance
			? canEditTrigger(trigger)
			: instance
				? instance.canEdit
				: canEditTrigger(trigger))
	// A brand-new instance has no overrides yet — do not show the primary
	// instance's stored picks as if they already applied.
	const mappingSource = options.createInstance
		? []
		: (instance?.mappings ?? trigger.mappings)
	const rows = editable
		? triggerMappingRows(context.view, {
				...trigger,
				mappings: mappingSource,
			})
		: mappingSource.flatMap((mapping) => {
				const need = context.view.needs.find(
					(candidate) => candidate.key === mapping.needKey,
				)
				return need ? [{ need, mapping }] : []
			})
	if (rows.length === 0) {
		return (
			<p mix={css(mutedCss)}>
				Runs of this trigger use the package’s default mappings.
			</p>
		)
	}
	const mappingTarget: CredentialMappingTarget = {
		type: 'trigger',
		trigger: trigger.trigger,
		...(instance ? { enablementId: instance.enablement.id } : {}),
		...(options.createInstance ? { createInstance: true } : {}),
	}
	return (
		<div mix={css({ display: 'grid', gap: spacing.sm })}>
			{editable &&
			trigger.canEdit &&
			(options.createInstance || (!instance && trigger.enablement === null)) ? (
				<p
					data-testid="package-trigger-will-enable"
					mix={css({ margin: 0, color: colors.warningText })}
				>
					{options.createInstance
						? 'Saving a credential choice here turns on another instance for you.'
						: 'This trigger is off. Saving a credential choice here turns it on for you.'}
				</p>
			) : null}
			<div mix={css({ overflowX: 'auto' })}>
				<table mix={css(tableCss)}>
					<thead>
						<tr>
							<th scope="col">Need</th>
							<th scope="col">This trigger</th>
							<th scope="col">Runs use</th>
							<th scope="col">Status</th>
						</tr>
					</thead>
					<tbody>
						{rows.map(({ need, mapping }) => (
							<tr key={need.key}>
								<td>
									<strong>{need.key}</strong>
								</td>
								<td>
									{renderMappingCell(context, {
										target: mappingTarget,
										need,
										stored: mapping?.override ?? null,
										inheritLabel: 'Inherits your default',
										editable,
										trigger,
									})}
								</td>
								<td>
									{mapping ? (
										renderEffective(context.orgSlug, mapping.effective)
									) : (
										<span mix={css(mutedCss)}>Your default, once on</span>
									)}
								</td>
								<td>{mapping ? renderStatus(mapping.effective) : null}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	)
}

function renderEnablementSwitch(input: {
	context: PackageTabContext
	trigger: PackageTriggerView
	checked: boolean
	enablementId?: string
	label: string
	disabled?: boolean
}) {
	const setEnablement = input.context.setTriggerEnablement
	if (!setEnablement || input.disabled) {
		return <span mix={css(mutedCss)}>{input.label}</span>
	}
	const busyKey =
		input.enablementId ??
		`${input.trigger.trigger.kind}:${input.trigger.trigger.name}`
	const busy = input.context.enablementBusyKey === busyKey
	return (
		<button
			type="button"
			role="switch"
			aria-checked={input.checked ? 'true' : 'false'}
			aria-label={`${input.label}: ${describeTrigger(input.trigger.trigger)}`}
			data-testid={`package-trigger-switch-${input.trigger.trigger.kind}-${input.trigger.trigger.name}${input.enablementId ? `-${input.enablementId}` : ''}`}
			disabled={busy || Boolean(input.context.enablementBusyKey)}
			mix={[
				css(switchTrackCss),
				on('click', () => {
					setEnablement({
						trigger: input.trigger.trigger,
						state: input.checked ? 'off' : 'on',
						...(input.enablementId ? { enablementId: input.enablementId } : {}),
					})
				}),
			]}
		/>
	)
}

function renderInstanceCard(
	context: PackageTabContext,
	trigger: PackageTriggerView,
	instance: PackageTriggerInstanceView,
	index: number,
	total: number,
) {
	const stateLabel = triggerEnablementStateLabel(instance.enablement)
	const canToggle =
		Boolean(context.setTriggerEnablement) &&
		instance.canEdit &&
		instance.enablement.enabledByYou
	return (
		<div
			key={instance.enablement.id}
			data-testid={`package-trigger-instance-${instance.enablement.id}`}
			mix={css({
				display: 'grid',
				gap: spacing.sm,
				paddingTop: index === 0 ? 0 : spacing.sm,
				borderTop: index === 0 ? 'none' : `1px solid ${colors.border}`,
			})}
		>
			<div
				mix={css({
					...rowCss,
					justifyContent: 'space-between',
					alignItems: 'center',
				})}
			>
				<div mix={css({ display: 'grid', gap: spacing.xs, minWidth: 0 })}>
					{total > 1 ? (
						<p
							mix={css({
								margin: 0,
								fontWeight: typography.fontWeight.semibold,
							})}
						>
							{instance.instanceLabel?.trim()
								? instance.instanceLabel.trim()
								: `Instance ${index + 1}`}
						</p>
					) : instance.instanceLabel?.trim() ? (
						<p
							mix={css({
								margin: 0,
								fontWeight: typography.fontWeight.semibold,
							})}
						>
							{instance.instanceLabel.trim()}
						</p>
					) : null}
					<span mix={css(mutedCss)}>{stateLabel}</span>
				</div>
				{canToggle ? (
					renderEnablementSwitch({
						context,
						trigger,
						checked: instance.enablement.state !== 'off',
						enablementId: instance.enablement.id,
						label: instance.enablement.state === 'off' ? 'Off' : 'On',
					})
				) : total > 1 ? (
					<span mix={css(mutedCss)}>{stateLabel}</span>
				) : null}
			</div>
			{renderTriggerMappings(context, trigger, instance)}
			<details mix={css(accountDisclosureCss)}>
				<summary>Details</summary>
				<p mix={css({ ...mutedCss, fontFamily: typography.fontFamilyMono })}>
					Enablement id: {instance.enablement.id}
				</p>
			</details>
		</div>
	)
}

export function renderTriggersTab(context: PackageTabContext): RemixNode {
	const { view } = context
	if (view.triggers.length === 0) {
		return (
			<section mix={css(cardCss)}>
				<p mix={css(mutedCss)}>
					This package declares no schedules, subscriptions, or webhooks.
				</p>
			</section>
		)
	}
	return (
		<div mix={css(tabBodyCss)}>
			{renderIncomplete(context, 'triggers')}
			<p mix={css(mutedCss)}>
				Each trigger runs as the person who turned it on. A trigger can map its
				own credentials; any need it leaves alone uses that person’s default
				mapping. You can turn on more than one instance of a schedule or
				subscription with different credentials.
			</p>
			{context.enablementError ? (
				<p
					role="alert"
					data-testid="package-trigger-enablement-error"
					mix={css({ margin: 0, color: colors.danger })}
				>
					{context.enablementError}
				</p>
			) : null}
			{view.triggers.map((trigger, index) => {
				const id = `package-trigger-${trigger.trigger.kind}-${trigger.trigger.name}`
				// Trigger names may hold spaces; aria-labelledby splits on them.
				const titleId = `package-trigger-title-${index}`
				const instances = trigger.instances
				const canToggle = canToggleTriggerEnablement(trigger)
				const webhookNeedsApprove =
					trigger.trigger.kind === 'webhook' &&
					trigger.instanceId !== null &&
					trigger.enablement === null &&
					trigger.canEdit
				const approveHref = webhookNeedsApprove
					? buildCredentialApprovalHref({
							username: context.username,
							kodyId: context.kodyId,
							changes: [],
							enable: [trigger.trigger],
						})
					: null
				return (
					<section
						key={id}
						aria-labelledby={titleId}
						data-testid={id}
						mix={css(cardCss)}
					>
						<div
							mix={css({
								...rowCss,
								justifyContent: 'space-between',
								alignItems: 'center',
							})}
						>
							<h2 id={titleId} mix={css(cardTitleCss)}>
								{describeTrigger(trigger.trigger)}
							</h2>
							{instances.length === 0 ? (
								canToggle ? (
									renderEnablementSwitch({
										context,
										trigger,
										checked: false,
										label: 'Off',
									})
								) : approveHref ? (
									<a
										href={approveHref}
										mix={css({ fontSize: typography.fontSize.sm })}
									>
										Approve to turn on
									</a>
								) : (
									<span mix={css(mutedCss)}>{triggerStateLabel(trigger)}</span>
								)
							) : instances.length > 1 ? (
								<span mix={css(mutedCss)}>{instances.length} instances</span>
							) : null}
						</div>
						{instances.length === 0
							? renderTriggerMappings(context, trigger, null)
							: instances.map((instance, instanceIndex) =>
									renderInstanceCard(
										context,
										trigger,
										instance,
										instanceIndex,
										instances.length,
									),
								)}
						{trigger.canAddInstance && instances.length > 0 ? (
							<details
								mix={css({
									...accountDisclosureCss,
									paddingTop: spacing.sm,
									borderTop: `1px solid ${colors.border}`,
								})}
								data-testid={`package-trigger-add-instance-${trigger.trigger.kind}-${trigger.trigger.name}`}
							>
								<summary>Add another instance</summary>
								<div mix={css({ display: 'grid', gap: spacing.sm })}>
									{trigger.trigger.kind === 'webhook' ? (
										<>
											<p mix={css(mutedCss)}>
												Mint another URL under this webhook name in Settings
												(give it a short label). Each new URL needs its own
												Approve before it runs.
											</p>
											<a
												href={`/@${context.username}/${context.kodyId}/settings#webhooks`}
												mix={css({ fontSize: typography.fontSize.sm })}
											>
												Open Settings → Webhooks
											</a>
										</>
									) : context.setTriggerEnablement ? (
										<>
											<p mix={css(mutedCss)}>
												Adds another live copy that uses your default
												credentials. Then change that instance’s credential
												mapping on its card (saving one need at a time never
												mints a second copy).
											</p>
											<button
												type="button"
												disabled={Boolean(context.enablementBusyKey)}
												mix={[
													css(secondaryButtonCss),
													on('click', () => {
														context.setTriggerEnablement?.({
															trigger: trigger.trigger,
															state: 'on',
															createInstance: true,
														})
													}),
												]}
											>
												Add another instance
											</button>
										</>
									) : null}
								</div>
							</details>
						) : null}
					</section>
				)
			})}
		</div>
	)
}
