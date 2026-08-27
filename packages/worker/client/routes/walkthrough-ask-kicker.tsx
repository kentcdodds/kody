import { css } from 'remix/ui'
import {
	joinWalkthroughHostLabels,
	listWalkthroughConversationHosts,
	walkthroughHostMarkUrl,
	type WalkthroughHost,
	type WalkthroughHostPick,
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
				mix={css(titleMarkCss)}
				style={{
					'--chip-icon': `url("${walkthroughHostMarkUrl(host)}")`,
				}}
				title={host.label}
			></span>
		</span>
	))
}

const titleMarkCss = {
	width: '0.85em',
	height: '0.85em',
	flex: 'none',
	display: 'inline-block' as const,
	verticalAlign: '-0.05em' as const,
	background: 'currentColor',
	maskImage: 'var(--chip-icon)',
	maskPosition: 'center',
	maskSize: 'contain',
	maskRepeat: 'no-repeat',
	WebkitMaskImage: 'var(--chip-icon)',
	WebkitMaskPosition: 'center',
	WebkitMaskSize: 'contain',
	WebkitMaskRepeat: 'no-repeat',
}
