import { css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import {
	credentialCreateKindSummary,
	type KeyFormState,
	writeCredentialCreateKind,
} from '#client/routes/connect-credential-shared.ts'
import {
	type CredentialKind,
	type CredentialListItem,
} from '#universal/credential-contracts.ts'
import {
	type AccountCredentialsResponse,
	credentialKindLabel,
} from '#universal/credentials-list.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import {
	cardCss,
	fieldCss,
	fieldLabelCss,
	inputCss,
} from '#universal/styles/style-primitives.ts'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'

const kindGridCss = {
	display: 'grid',
	gap: spacing.sm,
	gridTemplateColumns: 'repeat(auto-fill, minmax(14rem, 1fr))',
	margin: 0,
	padding: 0,
	border: 'none',
}

const kindOptionCss = {
	display: 'grid',
	gap: spacing.xs,
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	color: colors.text,
	textDecoration: 'none',
	'&:hover': { borderColor: colors.primary },
}

const kindOptionSelectedCss = {
	...kindOptionCss,
	borderColor: colors.primary,
	boxShadow: `inset 0 0 0 1px ${colors.primary}`,
}

const mutedCss = { margin: 0, color: colors.textMuted }
const choiceRowCss = {
	display: 'flex',
	gap: spacing.sm,
	alignItems: 'baseline',
}

function renderKindOption(input: {
	kind: CredentialKind
	selected: boolean
	href: string
}) {
	return (
		<li key={input.kind} mix={css({ listStyle: 'none' })}>
			<a
				href={input.href}
				aria-current={input.selected ? 'true' : undefined}
				data-testid={`credential-kind-${input.kind}`}
				mix={css(input.selected ? kindOptionSelectedCss : kindOptionCss)}
			>
				<strong>{credentialKindLabel(input.kind)}</strong>
				<span mix={css({ color: colors.textMuted })}>
					{credentialCreateKindSummary(input.kind)}
				</span>
			</a>
		</li>
	)
}

export function renderMatches(input: {
	matches: ReadonlyArray<CredentialListItem>
	orgSlug: string
}) {
	if (input.matches.length === 0) return null
	return (
		<section mix={css(cardCss)} data-testid="connect-credential-matches">
			<p mix={css({ margin: 0 })}>
				You already have{' '}
				{input.matches.length === 1
					? 'a credential'
					: `${input.matches.length} credentials`}{' '}
				from this provider. If one fits, you do not need a new one.
			</p>
			<ul mix={css({ margin: 0, paddingLeft: spacing.lg })}>
				{input.matches.map((credential) => (
					<li key={credential.id}>
						<a
							href={orgResourcePath(
								input.orgSlug,
								'credentials',
								encodeURIComponent(credential.id),
							)}
						>
							{credential.name}
						</a>{' '}
						<span mix={css({ color: colors.textMuted })}>
							({credentialKindLabel(credential.kind)})
						</span>
					</li>
				))}
			</ul>
		</section>
	)
}

/** The kind chooser: each option keeps the link's prefill. */
export function renderKindList(input: {
	kinds: ReadonlyArray<CredentialKind>
	selected: CredentialKind | null
	href: string
}) {
	return (
		<ul mix={css(kindGridCss)}>
			{input.kinds.map((kind) =>
				renderKindOption({
					kind,
					selected: kind === input.selected,
					href: writeCredentialCreateKind(input.href, kind),
				}),
			)}
		</ul>
	)
}

export function renderPackageAccess(input: {
	state: KeyFormState
	packages: AccountCredentialsResponse['packages']
	/** Only a Key can belong to one package; other kinds can only be locked. */
	packageKeys: boolean
	update: (patch: Partial<KeyFormState>) => void
}) {
	const { state, packages, packageKeys, update } = input
	const packageScoped = packageKeys && state.packageScope === 'package'
	const known = new Set(packages.map((entry) => entry.id))
	const unknownLocks = state.allowedPackages.filter((id) => !known.has(id))
	const toggleLock = (id: string, checked: boolean) =>
		update({
			allowedPackages: checked
				? [...new Set([...state.allowedPackages, id])]
				: state.allowedPackages.filter((entry) => entry !== id),
		})
	return (
		<fieldset
			data-testid="connect-credential-package-access"
			mix={css({ ...fieldCss, border: 'none', margin: 0, padding: 0 })}
		>
			<legend mix={css(fieldLabelCss)}>Which packages can read it</legend>
			{packageKeys ? (
				<>
					<label mix={css(choiceRowCss)}>
						<input
							type="radio"
							name="connect-credential-package-scope"
							checked={!packageScoped}
							mix={on('change', () =>
								update({ packageScope: 'org', replaceExisting: false }),
							)}
						/>
						<span>
							Packages in this org (lock it to some below, or leave it open)
						</span>
					</label>
					<label mix={css(choiceRowCss)}>
						<input
							type="radio"
							name="connect-credential-package-scope"
							checked={packageScoped}
							disabled={packages.length === 0}
							mix={on('change', () =>
								update({ packageScope: 'package', replaceExisting: false }),
							)}
						/>
						<span>
							One package only (a package key that no other package or agent
							code reads)
						</span>
					</label>
				</>
			) : null}
			{packageScoped ? (
				<select
					aria-label="Package that owns this key"
					value={state.packageId}
					mix={[
						css(inputCss),
						on('change', (event) =>
							update({
								packageId: event.currentTarget.value,
								replaceExisting: false,
							}),
						),
					]}
				>
					<option value="">Choose a package</option>
					{packages.map((entry) => (
						<option key={entry.id} value={entry.id}>
							{entry.kodyId}
						</option>
					))}
				</select>
			) : packages.length > 0 || unknownLocks.length > 0 ? (
				<div
					role="group"
					aria-label="Lock to packages"
					mix={css({ display: 'grid', gap: spacing.xs })}
				>
					{packages.map((entry) => (
						<label key={entry.id} mix={css(choiceRowCss)}>
							<input
								type="checkbox"
								checked={state.allowedPackages.includes(entry.id)}
								mix={on('change', (event) =>
									toggleLock(entry.id, event.currentTarget.checked),
								)}
							/>
							<span>
								Lock to <code>{entry.kodyId}</code>
							</span>
						</label>
					))}
					{unknownLocks.map((id) => (
						<label key={id} mix={css(choiceRowCss)}>
							<input
								type="checkbox"
								checked
								mix={on('change', (event) =>
									toggleLock(id, event.currentTarget.checked),
								)}
							/>
							<span>
								Lock to package <code>{id}</code>{' '}
								<span mix={css({ color: colors.textMuted })}>
									(not found in this org)
								</span>
							</span>
						</label>
					))}
					<span mix={css(mutedCss)}>
						A locked key is readable only by the packages you check. With none
						checked, any package in this org can use it.
					</span>
				</div>
			) : null}
		</fieldset>
	)
}
