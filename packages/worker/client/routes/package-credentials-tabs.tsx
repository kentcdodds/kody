import { type RemixNode, css } from 'remix/component'
import {
	canEditTrigger,
	triggerMappingRows,
} from '#client/routes/package-credentials-editing.ts'
import {
	type CredentialMappingTarget,
	type CredentialRef,
	type EffectiveCredentialMapping,
	type PackageCredentialNeedView,
	type PackageCredentialsView,
	type PackageTriggerView,
	type StoredCredentialMapping,
} from '#universal/credential-contracts.ts'
import { credentialKindLabel } from '#universal/credentials-list.ts'
import {
	credentialRefHref,
	credentialRefLabel,
	describeIncompleteMapping,
	describeTrigger,
	incompleteMappingTab,
	type MappingStatusTone,
	mappingSourceLabel,
	mappingStatusLabel,
	packageCredentialsTabHref,
	packageCredentialsTabLabel,
	type PackageCredentialsTab,
	sortNeedsByAttention,
	triggerStateLabel,
	withheldTriggerMappingsNote,
} from '#universal/package-credentials-page.ts'
import {
	cardCss,
	cardTitleCss,
	insetCardCss,
	sectionTitleCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

/** One stored mapping a person may edit: a default layer or a trigger override. */
export type MappingCellInput = {
	target: CredentialMappingTarget
	need: PackageCredentialNeedView
	stored: StoredCredentialMapping | null
	inheritLabel: string
	editable: boolean
	trigger: PackageTriggerView | null
}

export type PackageTabContext = {
	orgSlug: string
	username: string
	kodyId: string
	view: PackageCredentialsView
	/** Renders an editable cell; without it, cells are read-only. */
	renderMappingCell?: (input: MappingCellInput) => RemixNode
}

function renderMappingCell(
	context: PackageTabContext,
	input: MappingCellInput,
) {
	return context.renderMappingCell
		? context.renderMappingCell(input)
		: renderStored(context.orgSlug, input.stored, input.inheritLabel)
}

const mutedCss = { margin: 0, color: colors.textMuted }
const listCss = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.sm,
}
const rowCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'baseline',
	gap: spacing.sm,
}
const tableCss = {
	width: '100%',
	borderCollapse: 'collapse' as const,
	fontSize: typography.fontSize.sm,
	'& th': {
		textAlign: 'left' as const,
		fontWeight: typography.fontWeight.semibold,
		color: colors.textMuted,
		padding: `${spacing.xs} ${spacing.sm}`,
		borderBottom: `1px solid ${colors.border}`,
	},
	'& td': {
		padding: spacing.sm,
		borderBottom: `1px solid ${colors.border}`,
		verticalAlign: 'top' as const,
	},
}

function toneColor(tone: MappingStatusTone) {
	switch (tone) {
		case 'ok':
			return colors.text
		case 'muted':
			return colors.textMuted
		case 'warning':
			return colors.warningText
		case 'danger':
			return colors.danger
		default: {
			const exhaustive: never = tone
			return exhaustive
		}
	}
}

function renderStatus(mapping: EffectiveCredentialMapping) {
	const { label, tone } = mappingStatusLabel(mapping.status)
	return (
		<span
			data-mapping-status={mapping.status}
			mix={css({
				display: 'inline-flex',
				padding: `0 ${spacing.sm}`,
				borderRadius: radius.full,
				border: `1px solid ${tone === 'ok' ? colors.border : toneColor(tone)}`,
				color: toneColor(tone),
				fontSize: typography.fontSize.xs,
				fontWeight: typography.fontWeight.semibold,
				whiteSpace: 'nowrap',
			})}
		>
			{label}
		</span>
	)
}

function renderRefs(orgSlug: string, refs: ReadonlyArray<CredentialRef>) {
	if (refs.length === 0) return <span mix={css(mutedCss)}>—</span>
	return (
		<span
			mix={css({ display: 'inline-flex', flexWrap: 'wrap', gap: spacing.xs })}
		>
			{refs.map((ref, index) => (
				<span key={ref.id}>
					<a href={credentialRefHref(orgSlug, ref)}>
						{credentialRefLabel(ref)}
					</a>
					{index < refs.length - 1 ? ',' : ''}
				</span>
			))}
		</span>
	)
}

/** What a run would use for a need: its refs, or the candidates to pick from. */
function renderEffective(orgSlug: string, mapping: EffectiveCredentialMapping) {
	switch (mapping.status) {
		case 'ready':
			return renderRefs(orgSlug, mapping.credentials)
		case 'none':
			return <span mix={css(mutedCss)}>Nothing, on purpose</span>
		case 'unbound':
			return <span mix={css(mutedCss)}>No matching credential</span>
		case 'ambiguous':
			return <span>One of: {renderRefs(orgSlug, mapping.candidates)}</span>
		case 'unusable':
			return (
				<span mix={css({ color: colors.danger })}>
					A mapped credential can no longer be used
				</span>
			)
		default: {
			const exhaustive: never = mapping.status
			return exhaustive
		}
	}
}

export function renderStored(
	orgSlug: string,
	stored: StoredCredentialMapping | null,
	inheritLabel: string,
) {
	if (!stored) return <span mix={css(mutedCss)}>{inheritLabel}</span>
	if (stored.credentials.length === 0 && stored.unusableIds.length === 0) {
		return <span mix={css(mutedCss)}>None on purpose</span>
	}
	return (
		<span mix={css(rowCss)}>
			{renderRefs(orgSlug, stored.credentials)}
			{stored.unusableIds.length > 0 ? (
				<span mix={css({ color: colors.danger })}>
					({stored.unusableIds.length} can no longer be used)
				</span>
			) : null}
			{stored.updatedBy ? (
				<span mix={css(mutedCss)}>set by @{stored.updatedBy.username}</span>
			) : null}
		</span>
	)
}

function needSummary(need: PackageCredentialNeedView) {
	const kind = need.kind ? credentialKindLabel(need.kind) : 'Any kind'
	const parts = [kind, need.provider]
	if (need.multiple) parts.push('several allowed')
	if (need.from) parts.push(`from ${need.from}`)
	return parts.join(' · ')
}

const tabBodyCss = { display: 'grid', gap: spacing.md }

/** Every incomplete mapping on Credentials; on the other tabs, only the ones that tab fixes. */
function renderIncomplete(
	context: PackageTabContext,
	currentTab: PackageCredentialsTab,
) {
	const { view } = context
	const items =
		currentTab === 'credentials'
			? view.incomplete
			: view.incomplete.filter(
					(item) => incompleteMappingTab(item) === currentTab,
				)
	if (items.length === 0) return null
	const needs = new Map(view.needs.map((need) => [need.key, need]))
	return (
		<section
			aria-labelledby="package-credentials-incomplete"
			data-testid="package-credentials-incomplete"
			mix={css({
				...cardCss,
				borderColor: colors.warning,
				borderLeft: `4px solid ${colors.warning}`,
			})}
		>
			<h2 id="package-credentials-incomplete" mix={css(cardTitleCss)}>
				{items.length === 1
					? '1 mapping needs attention'
					: `${items.length} mappings need attention`}
			</h2>
			<ul mix={css(listCss)}>
				{items.map((item) => {
					const tab = incompleteMappingTab(item)
					const createUrl = needs.get(item.needKey)?.createUrl
					const key = `${item.needKey}:${item.where.type === 'trigger' ? `${item.where.trigger.kind}:${item.where.trigger.name}` : 'default'}`
					return (
						<li key={key} mix={css({ display: 'grid', gap: spacing.xs })}>
							<span>{describeIncompleteMapping(item)}</span>
							<span mix={css(rowCss)}>
								{tab === currentTab ? null : (
									<a
										href={packageCredentialsTabHref({
											username: context.username,
											kodyId: context.kodyId,
											tab,
										})}
									>
										Open {packageCredentialsTabLabel(tab)}
									</a>
								)}
								{item.status === 'unbound' && createUrl ? (
									<a href={createUrl}>Add a credential</a>
								) : null}
							</span>
						</li>
					)
				})}
			</ul>
		</section>
	)
}

export function renderCredentialsTab(context: PackageTabContext): RemixNode {
	const { view, orgSlug } = context
	const needs = sortNeedsByAttention(view.needs)
	return (
		<div mix={css(tabBodyCss)}>
			{renderIncomplete(context, 'credentials')}
			<section
				aria-labelledby="package-credentials-used"
				mix={css(cardCss)}
				data-testid="package-credentials-used"
			>
				<h2 id="package-credentials-used" mix={css(cardTitleCss)}>
					Used by this package
				</h2>
				{needs.length === 0 ? (
					<p mix={css(mutedCss)}>
						This package declares no credentials. A package lists what it needs
						in <code>kody.credentials</code>.
					</p>
				) : (
					<div mix={css({ overflowX: 'auto' })}>
						<table mix={css(tableCss)}>
							<thead>
								<tr>
									<th scope="col">Need</th>
									<th scope="col">Uses</th>
									<th scope="col">From</th>
									<th scope="col">Status</th>
								</tr>
							</thead>
							<tbody>
								{needs.map((need) => (
									<tr key={need.key} data-testid={`package-need-${need.key}`}>
										<td>
											<strong>{need.key}</strong>
											<div mix={css(mutedCss)}>{needSummary(need)}</div>
											{need.description ? (
												<div mix={css(mutedCss)}>{need.description}</div>
											) : null}
										</td>
										<td>{renderEffective(orgSlug, need.effective)}</td>
										<td>{mappingSourceLabel(need.effective.source)}</td>
										<td>{renderStatus(need.effective)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
				{view.triggers.length > 0 ? (
					<p mix={css(mutedCss)}>
						Triggers can map their own credentials. See{' '}
						<a
							href={packageCredentialsTabHref({
								username: context.username,
								kodyId: context.kodyId,
								tab: 'triggers',
							})}
						>
							Triggers
						</a>
						.
					</p>
				) : null}
			</section>
			<section
				aria-labelledby="package-credentials-locked"
				mix={css(cardCss)}
				data-testid="package-credentials-locked"
			>
				<h2 id="package-credentials-locked" mix={css(cardTitleCss)}>
					Locked to this package
				</h2>
				{view.locked.length === 0 ? (
					<p mix={css(mutedCss)}>
						No credential is locked to this package. Locking one from its detail
						pane keeps every other package from using it.
					</p>
				) : (
					<ul mix={css(listCss)}>
						{view.locked.map((credential) => (
							<li key={credential.id} mix={css(rowCss)}>
								<a
									href={credentialRefHref(orgSlug, {
										id: credential.id,
										name: credential.name,
										scope: credential.scope,
										kind: credential.kind,
									})}
								>
									{credential.name}
								</a>
								<span mix={css(mutedCss)}>
									{credentialKindLabel(credential.kind)}
									{credential.packageId ? ' · package Key' : ''}
									{credential.hosts.length > 0
										? ` · ${credential.hosts.join(', ')}`
										: ''}
								</span>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	)
}

export function renderMappingsTab(context: PackageTabContext): RemixNode {
	const { view, orgSlug } = context
	if (view.needs.length === 0) {
		return (
			<section mix={css(cardCss)}>
				<p mix={css(mutedCss)}>
					This package declares no credentials, so it has no default mappings.
				</p>
			</section>
		)
	}
	return (
		<div mix={css(tabBodyCss)}>
			{renderIncomplete(context, 'mappings')}
			<p mix={css(mutedCss)}>
				Default mappings pick the credential each need uses when you run the
				package yourself. Your default wins over the org default; with neither,
				Kody uses the only credential that matches.
			</p>
			{view.needs.map((need) => (
				<section
					key={need.key}
					aria-labelledby={`package-mapping-${need.key}`}
					data-testid={`package-mapping-${need.key}`}
					mix={css(cardCss)}
				>
					<div mix={css({ display: 'grid', gap: spacing.xs })}>
						<h2 id={`package-mapping-${need.key}`} mix={css(cardTitleCss)}>
							{need.key}
						</h2>
						<p mix={css(mutedCss)}>{needSummary(need)}</p>
						{need.description ? (
							<p mix={css(mutedCss)}>{need.description}</p>
						) : null}
					</div>
					<dl mix={css({ margin: 0, display: 'grid', gap: spacing.sm })}>
						<div mix={css(insetCardCss)}>
							<dt mix={css(sectionTitleCss)}>Org default</dt>
							<dd mix={css({ margin: 0 })}>
								{renderMappingCell(context, {
									target: { type: 'default', layer: 'org' },
									need,
									stored: need.defaults.org,
									inheritLabel: 'Not set',
									editable: view.package.canManage,
									trigger: null,
								})}
							</dd>
						</div>
						<div mix={css(insetCardCss)}>
							<dt mix={css(sectionTitleCss)}>Your default</dt>
							<dd mix={css({ margin: 0 })}>
								{renderMappingCell(context, {
									target: { type: 'default', layer: 'mine' },
									need,
									stored: need.defaults.mine,
									inheritLabel: 'Not set (uses the org default)',
									editable: true,
									trigger: null,
								})}
							</dd>
						</div>
						<div mix={css(insetCardCss)}>
							<dt mix={css(sectionTitleCss)}>Your runs use</dt>
							<dd mix={css({ ...rowCss, margin: 0 })}>
								{renderEffective(orgSlug, need.effective)}
								<span mix={css(mutedCss)}>
									{mappingSourceLabel(need.effective.source)}
								</span>
								{renderStatus(need.effective)}
							</dd>
						</div>
					</dl>
					<a href={need.createUrl}>Add a credential for {need.key}</a>
				</section>
			))}
		</div>
	)
}

function renderTriggerMappings(
	context: PackageTabContext,
	trigger: PackageTriggerView,
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
	const editable = Boolean(context.renderMappingCell) && canEditTrigger(trigger)
	const rows = editable
		? triggerMappingRows(context.view, trigger)
		: trigger.mappings.flatMap((mapping) => {
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
	return (
		<div mix={css({ display: 'grid', gap: spacing.sm })}>
			{editable && trigger.canEdit && trigger.enablement === null ? (
				<p
					data-testid="package-trigger-will-enable"
					mix={css({ margin: 0, color: colors.warningText })}
				>
					This trigger is off. Saving a credential choice here turns it on for
					you.
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
										target: { type: 'trigger', trigger: trigger.trigger },
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
				mapping.
			</p>
			{view.triggers.map((trigger, index) => {
				const id = `package-trigger-${trigger.trigger.kind}-${trigger.trigger.name}`
				// Trigger names may hold spaces; aria-labelledby splits on them.
				const titleId = `package-trigger-title-${index}`
				return (
					<section
						key={id}
						aria-labelledby={titleId}
						data-testid={id}
						mix={css(cardCss)}
					>
						<div mix={css({ ...rowCss, justifyContent: 'space-between' })}>
							<h2 id={titleId} mix={css(cardTitleCss)}>
								{describeTrigger(trigger.trigger)}
							</h2>
							<span mix={css(mutedCss)}>{triggerStateLabel(trigger)}</span>
						</div>
						{renderTriggerMappings(context, trigger)}
					</section>
				)
			})}
		</div>
	)
}
