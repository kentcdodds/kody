import { type Handle } from 'remix/component'
import {
	at,
	icon,
	PrimitiveWidgetFrame,
	wire,
	wires,
} from '#client/primitive-widget-parts.tsx'

/**
 * `/features/secrets` scenes. The page's buttons drive them; each scene
 * holds the visible example, and `public/feature-scenes/secrets.css`
 * animates it. A keyed `.pw-run` restarts the timeline on every click.
 * Status text that screen readers hear stays outside `.pw-run`, because
 * that node remounts.
 */

const secretRef = '{{secret:stripe}}'
const attachedKey = 'Bearer sk_••••4f2a'

export type SecretHost = 'approved' | 'blocked'

const tripHeight = 220

function hostName(host: SecretHost) {
	switch (host) {
		case 'approved':
			return 'api.stripe.com'
		case 'blocked':
			return 'paste.example'
		default: {
			const never: never = host
			return never
		}
	}
}

function destinationLabel(host: SecretHost) {
	switch (host) {
		case 'approved':
			return 'Approved API host'
		case 'blocked':
			return 'Unapproved host'
		default: {
			const never: never = host
			return never
		}
	}
}

function resultCopy(host: SecretHost, sent: boolean) {
	if (!sent) return 'Ready to send an example request.'
	switch (host) {
		case 'approved':
			return 'Request sent to the approved host.'
		case 'blocked':
			return 'Blocked. This host is not approved.'
		default: {
			const never: never = host
			return never
		}
	}
}

function httpLines(host: SecretHost) {
	switch (host) {
		case 'approved':
			return ['200 OK', 'ch_3Qx8k2eL', '$42.00 paid']
		case 'blocked':
			return ['0 bytes sent', 'nothing left']
		default: {
			const never: never = host
			return never
		}
	}
}

export function SecretsTripScene(
	handle: Handle<{ host: SecretHost; sent: boolean; shot: number }>,
) {
	return () => {
		const { host, sent, shot } = handle.props
		const blocked = host === 'blocked'
		const name = hostName(host)
		const wireY = Math.round(tripHeight * 0.14)
		const release = sent && !blocked
		return (
			<div class="pw-sec-stack">
				<PrimitiveWidgetFrame
					id="secrets"
					size="full"
					height={tripHeight}
					class="pw-scene-sec-trip"
				>
					<div
						class="pw-run"
						key={`${host}-${sent ? 'sent' : 'ready'}-${shot}`}
						data-host={host}
						data-sent={sent ? '' : undefined}
						data-blocked={sent && blocked ? '' : undefined}
					>
						{wires(
							<>
								{wire({
									key: 'ref',
									d: `M59 ${wireY} L180 ${wireY}`,
									on: true,
								})}
								{wire({
									key: 'drop-agent',
									d: `M59 ${wireY} L59 128`,
									on: true,
								})}
								{wire({
									key: 'drop-kody',
									d: `M180 ${wireY} L180 128`,
									on: true,
								})}
								{wire({
									key: 'out',
									d: `M180 ${wireY} L301 ${wireY}`,
									on: release,
								})}
								{wire({
									key: 'drop-host',
									d: `M301 ${wireY} L301 128`,
									on: release,
								})}
							</>,
							tripHeight,
						)}
						<div
							class="pw-sec-lane pw-sec-lane-ref"
							style={{ left: '16.5%', width: '33.5%', top: '14%' }}
						>
							<span class="pw-sec-packet">{secretRef}</span>
						</div>
						{release ? (
							<div
								class="pw-sec-lane pw-sec-lane-key"
								style={{ left: '50%', width: '33.5%', top: '14%' }}
							>
								<span class="pw-sec-packet pw-sec-packet-key">sk_••••</span>
							</div>
						) : null}
						{sent && blocked ? (
							<span class="pw-sec-stamp" style={at(67, 14)} aria-hidden="true">
								✕
							</span>
						) : null}
						<div class="pw-node pw-sec-card pw-sec-agent" style={at(0, 60)}>
							<div class="pw-sec-head">
								{icon('claude')}
								<strong>Agent sees</strong>
							</div>
							<span class="pw-sec-pill">Reference only</span>
							<p class="pw-sec-ask">Charge invoice 2041.</p>
							<code class="pw-sec-ref pw-sec-live">{secretRef}</code>
							<span class="pw-sec-mask">
								<code>sk_••••••••</code>
								<small>masked</small>
							</span>
							<span class="pw-sec-k">POST /v1/charges</span>
							<span class="pw-sec-host-name">{name}</span>
						</div>
						<div class="pw-node pw-sec-card pw-sec-kody" style={at(36, 60)}>
							<div class="pw-sec-head">
								<span class="pw-lock" aria-hidden="true"></span>
								<strong>Kody</strong>
							</div>
							<span class="pw-sec-k">Allowed host</span>
							<span
								class="pw-sec-rule"
								data-on={!blocked ? '' : undefined}
								data-verdict="pass"
							>
								<span>api.stripe.com</span>
								<b>✓</b>
							</span>
							<span class="pw-sec-rule">
								<span>api.example.com</span>
								<b>✓</b>
							</span>
							<span
								class="pw-sec-rule"
								data-on={blocked ? '' : undefined}
								data-verdict="fail"
							>
								<span>paste.example</span>
								<b>{blocked ? '✕' : '·'}</b>
							</span>
							<span class="pw-sec-k">Resolved by Kody</span>
						</div>
						<div class="pw-node pw-sec-card pw-sec-host" style={at(68, 60)}>
							<div class="pw-sec-head">
								{blocked ? (
									<span class="pw-sec-deny" aria-hidden="true">
										✕
									</span>
								) : (
									icon('stripe')
								)}
								<strong id="destination">{destinationLabel(host)}</strong>
							</div>
							<span class="pw-sec-host-name">{name}</span>
							<span class="pw-sec-k">Authorization</span>
							<span id="ui-auth-status">
								{sent && !blocked ? 'Added at request boundary' : 'Not sent'}
							</span>
							<code class="pw-sec-bearer">
								{release
									? attachedKey
									: sent
										? 'nothing attached'
										: 'key withheld'}
							</code>
							{sent ? (
								<p class="pw-sec-http">
									{httpLines(host).map((line) => (
										<span key={line}>{line}</span>
									))}
								</p>
							) : null}
						</div>
					</div>
				</PrimitiveWidgetFrame>
				<p id="secret-result" role="status">
					{resultCopy(host, sent)}
				</p>
			</div>
		)
	}
}

export type SecretApproval = 'host' | 'package' | 'expiry'

const accessHeight = 220

const accessRows: Record<
	SecretApproval,
	{ label: string; value: string; verdict: 'pass' | 'fail'; y: number }
> = {
	host: {
		label: 'Allowed host',
		value: 'api.example.com',
		verdict: 'pass',
		y: 38,
	},
	package: {
		label: 'Package',
		value: 'weekly-brief',
		verdict: 'pass',
		y: 58,
	},
	expiry: {
		label: 'Expiry',
		value: 'Checked before use',
		verdict: 'fail',
		y: 78,
	},
}

function accessRequest(approval: SecretApproval) {
	switch (approval) {
		case 'host':
			return {
				title: 'POST /v1/charges',
				detail: 'api.example.com',
				note: 'Host is on the allowlist',
			}
		case 'package':
			return {
				title: 'weekly-brief',
				detail: 'Authored by you',
				note: 'Use is automatic',
			}
		case 'expiry':
			return {
				title: 'stripe',
				detail: 'Expired 2 Mar 2026',
				note: 'Listed, not resolved',
			}
		default: {
			const never: never = approval
			return never
		}
	}
}

function verdictWord(verdict: 'pass' | 'fail') {
	switch (verdict) {
		case 'pass':
			return 'Pass'
		case 'fail':
			return 'Blocked'
		default: {
			const never: never = verdict
			return never
		}
	}
}

export function SecretsAccessScene(
	handle: Handle<{ approval: SecretApproval; shot: number }>,
) {
	return () => {
		const { approval, shot } = handle.props
		const request = accessRequest(approval)
		const rowY = Math.round((accessRows[approval].y / 100) * accessHeight)
		return (
			<PrimitiveWidgetFrame
				id="secrets"
				size="full"
				height={accessHeight}
				class="pw-scene-sec-access"
			>
				<div
					class="pw-run"
					key={`${approval}-${shot}`}
					data-approval={approval}
				>
					{wires(
						wire({
							key: 'check',
							d: `M124 110 C154 110 168 ${rowY} 187 ${rowY}`,
							on: true,
						}),
						accessHeight,
					)}
					<div class="pw-node pw-sec-card pw-sec-request" style={at(0, 50)}>
						<span class="pw-kicker">Incoming request</span>
						<strong>{request.title}</strong>
						<span>{request.detail}</span>
						<code>{secretRef}</code>
						<small class="pw-sec-note">{request.note}</small>
					</div>
					<div class="pw-sec-sheet">
						<div class="pw-sec-head">
							<span class="pw-lock" aria-hidden="true"></span>
							<strong>Credential access</strong>
							<span class="pw-sec-pill">Example</span>
						</div>
					</div>
					{(Object.keys(accessRows) as Array<SecretApproval>).map((id) => {
						const row = accessRows[id]
						const on = id === approval
						return (
							<div
								key={id}
								class="pw-sec-row"
								data-on={on ? '' : undefined}
								data-verdict={row.verdict}
								style={at(52, row.y)}
							>
								<span>{row.label}</span>
								<b>{on ? verdictWord(row.verdict) : 'Not checked'}</b>
								<code>{row.value}</code>
							</div>
						)
					})}
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}

export type SecretSource = 'saved' | 'vault'

const vaultHeight = 244

function sourceLabel(source: SecretSource) {
	switch (source) {
		case 'saved':
			return 'Saved in Kody'
		case 'vault':
			return 'Configured vault provider'
		default: {
			const never: never = source
			return never
		}
	}
}

export function SecretsVaultScene(
	handle: Handle<{ source: SecretSource; shot: number }>,
) {
	return () => {
		const { source, shot } = handle.props
		const vault = source === 'vault'
		return (
			<PrimitiveWidgetFrame
				id="secrets"
				size="full"
				height={vaultHeight}
				class="pw-scene-sec-vault"
			>
				<div class="pw-run" key={`${source}-${shot}`} data-source={source}>
					{wires(
						<>
							{wire({ key: 'ref', d: 'M108 70 L148 70', on: true })}
							{wire({ key: 'fetch', d: 'M108 178 L148 178', on: true })}
							{wire({ key: 'key', d: 'M228 122 L262 122', on: true })}
						</>,
						vaultHeight,
					)}
					<div
						class="pw-sec-lane pw-sec-lane-ref"
						style={{ left: '30%', width: '11%', top: '28.7%' }}
					>
						<span class="pw-sec-packet">ref</span>
					</div>
					<div
						class="pw-sec-lane pw-sec-lane-fetch"
						style={{ left: '30%', width: '11%', top: '73%' }}
					>
						<span class="pw-sec-packet">{vault ? 'fetch' : 'saved'}</span>
					</div>
					<div
						class="pw-sec-lane pw-sec-lane-key"
						style={{ left: '63%', width: '10%', top: '50%' }}
					>
						<span class="pw-sec-packet pw-sec-packet-key">sk_••••</span>
					</div>
					<div class="pw-node pw-sec-card pw-sec-model" style={at(0, 28)}>
						<div class="pw-sec-head">
							{icon('claude')}
							<strong>Model</strong>
						</div>
						<p>Charge invoice 2041.</p>
						<span class="pw-sec-k">Sees the reference</span>
						<code class="pw-sec-ref">{secretRef}</code>
						<span class="pw-sec-mask">
							<code>sk_••••••••</code>
							<small>not visible</small>
						</span>
					</div>
					<div
						class="pw-node pw-sec-card pw-sec-source"
						id="ms-source-drawer"
						style={at(0, 73)}
					>
						{vault ? (
							<div class="pw-sec-op">
								<span class="pw-sec-op-mark" aria-hidden="true"></span>
								<strong>1Password</strong>
							</div>
						) : (
							<div class="pw-sec-head">
								<span class="pw-lock" aria-hidden="true"></span>
								<strong>Your account</strong>
							</div>
						)}
						<span class="pw-sec-k">
							{vault ? 'Private vault' : 'Saved secret'}
						</span>
						<span class="pw-sec-item">Stripe · live key</span>
						<code class="pw-sec-mask-code">sk_••••••••</code>
						<small id="ms-source-label">{sourceLabel(source)}</small>
					</div>
					<div class="pw-node pw-sec-card pw-sec-boundary" style={at(41, 50)}>
						<span class="pw-sec-glass" aria-hidden="true"></span>
						<strong>Request boundary</strong>
						<span class="pw-sec-k">
							{vault ? 'Fetches the vault item' : 'Attaches the saved key'}
						</span>
						<span class="pw-sec-hop">
							<span>in · reference</span>
							<span>out · key</span>
						</span>
					</div>
					<div class="pw-node pw-sec-card pw-sec-api" style={at(73, 50)}>
						<div class="pw-sec-head">
							{icon('stripe')}
							<strong>Approved API</strong>
						</div>
						<span class="pw-sec-host-name">api.stripe.com</span>
						<span class="pw-sec-k">receives key</span>
						<code class="pw-sec-bearer">{attachedKey}</code>
					</div>
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}

const draftHeight = 236

export function SecretsDraftScene(handle: Handle) {
	return () => {
		void handle.props
		return (
			<PrimitiveWidgetFrame
				id="secrets"
				size="full"
				height={draftHeight}
				class="pw-scene-sec-draft"
			>
				<div class="pw-run">
					{wires(
						wire({ key: 'draft', d: 'M122 118 L158 118', on: true }),
						draftHeight,
					)}
					<div
						class="pw-sec-lane pw-sec-lane-draft"
						style={{ left: '34%', width: '10%', top: '50%' }}
					>
						<span class="pw-sec-packet">draft</span>
					</div>
					<div
						class="pw-sec-lane pw-sec-lane-send"
						style={{ left: '34%', width: '10%', top: '50%' }}
					>
						<span class="pw-sec-packet">send</span>
					</div>
					<div class="pw-node pw-sec-card pw-sec-composer" style={at(0, 50)}>
						<div class="pw-sec-head">
							{icon('claude')}
							<strong>Agent</strong>
						</div>
						<p>Draft a reply to Morgan about invoice 2041. Do not send it.</p>
						<span class="pw-sec-k">drafts-only package</span>
					</div>
					<div class="pw-node pw-sec-card pw-sec-gmail" style={at(44, 50)}>
						<div class="pw-sec-head">
							<span class="pw-sec-gmail-mark" aria-hidden="true">
								M
							</span>
							<strong>Gmail</strong>
							<span class="pw-sec-pill">Drafts</span>
						</div>
						<div class="pw-sec-mail pw-sec-mail-new">
							<span class="pw-sec-who">Morgan Chen</span>
							<span class="pw-sec-pill">Draft</span>
							<strong>Re: March invoice</strong>
							<p>Thanks — attaching the receipt for 2041. I'll wait for you.</p>
						</div>
						<div class="pw-sec-mail">
							<span class="pw-sec-who">Northwind</span>
							<span class="pw-sec-pill">Draft</span>
							<strong>Weekly brief</strong>
							<p>Orchard update ships Thursday.</p>
						</div>
						<div class="pw-sec-sendbar">
							<div class="pw-sec-locked">
								<span class="pw-lock" aria-hidden="true"></span>
								<span>Send</span>
								<small>Locked</small>
							</div>
							<div class="pw-sec-you">
								<strong>You send</strong>
								<small>in Gmail</small>
							</div>
						</div>
						<small class="pw-sec-ready">Draft ready for your review</small>
					</div>
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}
