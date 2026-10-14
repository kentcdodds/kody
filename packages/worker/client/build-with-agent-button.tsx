import { type Handle, css } from 'remix/component'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { buildWithAgentPrompt } from '#universal/build-with-agent.ts'

export function BuildWithAgentButton(
	handle: Handle<{
		business?: boolean
		label?: string
		variant?: 'ghost' | 'pill'
		/** False keeps the prompt agent-led, with no `/onboarding` link. */
		onboardingPage?: boolean
	}>,
) {
	return () => {
		const { business, onboardingPage, variant = 'ghost' } = handle.props
		const label = handle.props.label ?? 'Build with your agent'
		return (
			<CopyTextButton
				variant={variant}
				value={buildWithAgentPrompt({ business, onboardingPage })}
				ariaLabel={`${label}, copy setup prompt`}
				copiedLabel="Copied! Paste into your agent"
				idleLabel={
					<span
						mix={css({
							display: 'inline-flex',
							alignItems: 'center',
							gap: '0.65rem',
						})}
					>
						<span
							aria-hidden="true"
							mix={css({ display: 'inline-flex', gap: '0.3rem' })}
						>
							{['claudecode', 'codex', 'cursor'].map((icon) => (
								<img
									key={icon}
									src={`/images/icons/${icon}.svg`}
									alt=""
									width={18}
									height={18}
									mix={css({
										background: '#fff',
										borderRadius: '3px',
										padding: '2px',
									})}
								/>
							))}
						</span>
						{label}
					</span>
				}
			/>
		)
	}
}
