import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { CopyCard } from '#client/routes/onboarding-mcp-client-cards.tsx'
import { onboardingUseKodyPromptForCustomName } from '#universal/onboarding-process.ts'
import {
	fieldCss,
	fieldLabelCss,
	inputCss,
} from '#universal/styles/style-primitives.ts'

/**
 * `/onboarding/step-2/not-listed`: type any service name and the CopyCard
 * prompt updates on each keystroke.
 */
export function OnboardingCustomServicePrompt(
	handle: Handle<{
		serviceName?: string
		onServiceNameChange?: (name: string) => void
	}>,
) {
	let localName = ''

	return () => {
		const controlled = handle.props.onServiceNameChange != null
		const serviceName = controlled
			? (handle.props.serviceName ?? '')
			: localName
		const prompt = onboardingUseKodyPromptForCustomName(serviceName)
		return (
			<div data-testid="onboarding-connected-prompt" mix={css(layoutCss)}>
				<label mix={css(fieldCss)}>
					<span mix={css(fieldLabelCss)}>Which service?</span>
					<input
						data-testid="onboarding-service-custom-name"
						data-field-ring
						type="text"
						value={serviceName}
						placeholder="Todoist, Figma, HubSpot…"
						autocomplete="off"
						mix={[
							css(inputCss),
							on('input', (event) => {
								const value = (event.currentTarget as HTMLInputElement).value
								if (handle.props.onServiceNameChange) {
									handle.props.onServiceNameChange(value)
									return
								}
								localName = value
								handle.update()
							}),
						]}
					/>
				</label>
				<CopyCard label="Prompt" value={prompt} copyLabel="Copy prompt" />
			</div>
		)
	}
}

const layoutCss = {
	display: 'grid',
	gap: '1.15rem',
	width: '100%',
	maxWidth: '68ch',
	justifyItems: 'stretch',
}
