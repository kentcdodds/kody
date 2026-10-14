import { type Handle, css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import {
	accountActionsCss,
	accountFieldNoteCss,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import { saveCredentialHosts } from '#client/routes/account-credentials-shared.ts'
import { type CredentialHostSettings } from '#universal/credentials-list.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

type CredentialHostsEditorProps = {
	credentialId: string
	credentialName: string
	settings: CredentialHostSettings
	/** The page href, so the save binds this page's org. */
	href: string
	onSaved: () => void
}

const listCss = css({
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.xs,
})

const rowCss = css({
	display: 'flex',
	flexWrap: 'wrap',
	alignItems: 'center',
	gap: spacing.sm,
})

const hostCss = css({
	fontFamily: 'monospace',
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere',
	color: colors.text,
})

const fixedNoteCss = css({
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
})

const addFormCss = css({
	display: 'flex',
	flexWrap: 'wrap',
	gap: spacing.sm,
	alignItems: 'center',
})

const inputCss = css({ ...accountInputCss, flex: '1 1 16rem' })

const errorCss = css({
	margin: 0,
	color: colors.error,
	fontSize: typography.fontSize.sm,
})

/** Lowercases and drops `https://` and a trailing slash; the server validates. */
function normalizeTypedHost(raw: string) {
	return raw
		.trim()
		.toLowerCase()
		.replace(/^https:\/\//, '')
		.replace(/\/$/, '')
}

/**
 * Lets the org edit where a Key or an OAuth connection may be sent. The hosts
 * of an OAuth connection's API base and token URLs stay fixed.
 */
export function CredentialHostsEditor(
	handle: Handle<CredentialHostsEditorProps>,
) {
	let editing = false
	let draft: Array<string> = []
	let typed = ''
	let saving = false
	let error: string | null = null
	let status: string | null = null

	function startEditing() {
		editing = true
		draft = [...handle.props.settings.hosts]
		typed = ''
		error = null
		status = null
		handle.update()
	}

	function cancel() {
		editing = false
		error = null
		handle.update()
	}

	function addTyped(event: SubmitEvent) {
		event.preventDefault()
		const raw = typed.trim()
		if (!raw) return
		if (raw.toLowerCase().startsWith('http://')) {
			error =
				'Kody sends credentials only over HTTPS. Enter the host without http://.'
			handle.update()
			return
		}
		const host = normalizeTypedHost(raw)
		if (
			draft.includes(host) ||
			handle.props.settings.fixedHosts.includes(host)
		) {
			error = `${host} is already allowed.`
			handle.update()
			return
		}
		draft = [...draft, host]
		typed = ''
		error = null
		handle.update()
	}

	function remove(host: string) {
		draft = draft.filter((entry) => entry !== host)
		error = null
		handle.update()
	}

	async function save() {
		if (saving) return
		saving = true
		error = null
		handle.update()
		const pending = normalizeTypedHost(typed)
		try {
			const saved = await saveCredentialHosts({
				href: handle.props.href,
				credentialId: handle.props.credentialId,
				hosts: pending ? [...draft, pending] : draft,
			})
			typed = ''
			saving = false
			editing = false
			status = saved.changed ? 'Hosts saved.' : 'No changes to save.'
			handle.props.onSaved()
		} catch (caught) {
			saving = false
			error =
				caught instanceof Error ? caught.message : 'Could not save the hosts.'
		}
		handle.update()
	}

	return () => {
		const { settings, credentialName } = handle.props
		if (!editing) {
			return (
				<div mix={css({ display: 'grid', gap: spacing.xs })}>
					<div>
						<button
							type="button"
							data-testid="credential-hosts-edit"
							mix={[
								css(getGhostButtonCss({ size: 'sm' })),
								on('click', startEditing),
							]}
						>
							Edit hosts
						</button>
					</div>
					{status ? (
						<p role="status" mix={css(accountFieldNoteCss)}>
							{status}
						</p>
					) : null}
				</div>
			)
		}
		return (
			<div
				data-testid="credential-hosts-editor"
				mix={css({ display: 'grid', gap: spacing.sm })}
			>
				<p mix={css(accountFieldNoteCss)}>
					Kody places this credential only on HTTPS requests to these hosts.
					Enter each host name, such as api.example.com. Wildcards, ports, and
					paths are not allowed.
				</p>
				<ul aria-label={`Hosts for ${credentialName}`} mix={listCss}>
					{settings.fixedHosts.map((host) => (
						<li key={`fixed:${host}`} mix={rowCss}>
							<span mix={hostCss}>{host}</span>
							<span mix={fixedNoteCss}>Always allowed</span>
						</li>
					))}
					{draft.map((host) => (
						<li key={host} mix={rowCss}>
							<span mix={hostCss}>{host}</span>
							<button
								type="button"
								aria-label={`Remove ${host}`}
								mix={[
									css(getGhostButtonCss({ size: 'sm' })),
									on('click', () => remove(host)),
								]}
							>
								Remove
							</button>
						</li>
					))}
				</ul>
				<form mix={[addFormCss, on('submit', addTyped)]}>
					<input
						type="text"
						name="host"
						data-field-ring
						data-testid="credential-hosts-input"
						aria-label="Host to allow"
						placeholder="api.example.com"
						autocomplete="off"
						spellcheck={false}
						value={typed}
						mix={[
							inputCss,
							on('input', (event) => {
								if (!(event.currentTarget instanceof HTMLInputElement)) return
								typed = event.currentTarget.value
								handle.update()
							}),
						]}
					/>
					<button type="submit" mix={css(getGhostButtonCss({ size: 'sm' }))}>
						Add host
					</button>
				</form>
				{error ? (
					<p role="alert" mix={errorCss}>
						{error}
					</p>
				) : null}
				<div mix={css(accountActionsCss)}>
					<button
						type="button"
						data-testid="credential-hosts-save"
						disabled={saving}
						mix={[css(getPillButtonCss({ size: 'sm' })), on('click', save)]}
					>
						{saving ? 'Saving…' : 'Save hosts'}
					</button>
					<button
						type="button"
						disabled={saving}
						mix={[css(getGhostButtonCss({ size: 'sm' })), on('click', cancel)]}
					>
						Cancel
					</button>
				</div>
			</div>
		)
	}
}
