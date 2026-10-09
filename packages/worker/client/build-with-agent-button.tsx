import { type Handle, css } from 'remix/component'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { buildWithAgentPrompt } from '#universal/build-with-agent.ts'

export function BuildWithAgentButton(handle: Handle<{ business?: boolean }>) {
	return () => (
		<CopyTextButton
			variant="ghost"
			value={buildWithAgentPrompt(handle.props.business)}
			ariaLabel="Build with your agent, copy setup prompt"
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
							/>
						))}
					</span>
					Build with your agent
				</span>
			}
		/>
	)
}
