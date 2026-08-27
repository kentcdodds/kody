import { css, type RemixNode } from 'remix/ui'
import {
	joinWalkthroughHostLabels,
	listWalkthroughConversationHosts,
	walkthroughHostMarkPaint,
	walkthroughHostMarkPaintCss,
	walkthroughHostMarkUrl,
	type WalkthroughHost,
	type WalkthroughHostPick,
	type WalkthroughHostSlot,
} from '#universal/walkthrough-hosts.ts'

export function renderWalkthroughPackageTitle(hosts?: WalkthroughHostPick) {
	if (!hosts) return 'What the agent wrote'
	const unique = listWalkthroughConversationHosts(hosts)
	if (unique.length === 0) return 'What the agent wrote'
	const noun = unique.length === 1 ? 'agent' : 'agents'
	return (
		<>
			What your {noun} {renderJoinedWalkthroughHostMarks(unique)} wrote
		</>
	)
}

export function walkthroughPackageTitleLabel(hosts?: WalkthroughHostPick) {
	if (!hosts) return 'What the agent wrote'
	const labels = listWalkthroughConversationHosts(hosts).map(
		(host) => host.label,
	)
	if (labels.length === 0) return 'What the agent wrote'
	const noun = labels.length === 1 ? 'agent' : 'agents'
	return `What your ${noun} ${joinWalkthroughHostLabels(labels)} wrote`
}

const walkthroughKickerToken = /\{(coding|invoke|notify)\}/g

/** Interpolate act-kicker tokens with a host mark to the left of the name. */
export function renderWalkthroughKicker(
	kicker: string,
	hosts?: WalkthroughHostPick | null,
) {
	if (!hosts) return kicker
	const nodes: Array<RemixNode> = []
	let lastIndex = 0
	for (const match of kicker.matchAll(walkthroughKickerToken)) {
		const slot = walkthroughKickerSlot(match[1])
		if (!slot) continue
		const index = match.index ?? 0
		if (index > lastIndex) nodes.push(kicker.slice(lastIndex, index))
		nodes.push(renderWalkthroughHostName(hosts[slot]))
		lastIndex = index + match[0].length
	}
	if (lastIndex < kicker.length) nodes.push(kicker.slice(lastIndex))
	return nodes
}

function walkthroughKickerSlot(
	value: string | undefined,
): WalkthroughHostSlot | undefined {
	switch (value) {
		case 'coding':
		case 'invoke':
		case 'notify':
			return value
		default:
			return undefined
	}
}

function renderWalkthroughHostName(host: WalkthroughHost) {
	return (
		<span key={host.id} mix={css(kickerHostCss)}>
			<span
				mix={css({
					...titleMarkBoxCss,
					...walkthroughHostMarkPaintCss(walkthroughHostMarkPaint(host)),
				})}
				style={{
					'--chip-icon': `url("${walkthroughHostMarkUrl(host)}")`,
				}}
				aria-hidden="true"
			></span>
			{host.label}
		</span>
	)
}

function renderJoinedWalkthroughHostMarks(
	hosts: ReadonlyArray<WalkthroughHost>,
) {
	return hosts.map((host, index) => (
		<span key={host.id}>
			{index === 0
				? null
				: index === hosts.length - 1
					? hosts.length === 2
						? ' and '
						: ', and '
					: ', '}
			<span
				mix={css({
					...titleMarkBoxCss,
					...walkthroughHostMarkPaintCss(walkthroughHostMarkPaint(host)),
				})}
				style={{
					'--chip-icon': `url("${walkthroughHostMarkUrl(host)}")`,
				}}
				title={host.label}
			></span>
		</span>
	))
}

const titleMarkBoxCss = {
	width: '0.85em',
	height: '0.85em',
	flex: 'none',
	display: 'inline-block' as const,
	verticalAlign: '-0.05em' as const,
}

const kickerHostCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.3em',
	whiteSpace: 'nowrap' as const,
	verticalAlign: '-0.12em' as const,
}
