import { type Handle, css } from 'remix/component'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import {
	ERROR_AGENT_PROMPT_IDLE_LABEL,
	ERROR_AGENT_PROMPT_TEST_ID,
} from '#universal/error-agent-prompt.ts'
import { spacing } from '#universal/styles/tokens.ts'

type ErrorAgentPromptButtonProps = {
	prompt: string
	/** Optional hint above the button. */
	hint?: string
	variant?: 'primary' | 'secondary' | 'pill' | 'ghost' | 'chip'
	size?: 'md' | 'sm'
	class?: string
}

const wrapCss = {
	display: 'grid',
	gap: spacing.sm,
	justifyItems: 'start' as const,
	marginTop: spacing.md,
}

const hintCss = {
	margin: 0,
	fontSize: '0.92rem',
	lineHeight: 1.45,
	maxWidth: '40rem',
}

/**
 * Hydrated “Copy prompt for your agent” control. Always stamps
 * `data-error-agent-prompt` so the inventory guard can find it.
 */
export function ErrorAgentPromptButton(
	handle: Handle<ErrorAgentPromptButtonProps>,
) {
	return () => (
		<div
			data-error-agent-prompt=""
			data-testid={ERROR_AGENT_PROMPT_TEST_ID}
			mix={css(wrapCss)}
		>
			{handle.props.hint ? <p mix={css(hintCss)}>{handle.props.hint}</p> : null}
			<CopyTextButton
				value={handle.props.prompt}
				idleLabel={ERROR_AGENT_PROMPT_IDLE_LABEL}
				variant={handle.props.variant ?? 'secondary'}
				size={handle.props.size}
				class={handle.props.class}
				ariaLabel={ERROR_AGENT_PROMPT_IDLE_LABEL}
			/>
		</div>
	)
}
