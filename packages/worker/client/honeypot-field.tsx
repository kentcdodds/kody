import { css } from 'remix/ui'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { honeypotFieldName } from '#universal/public-form-protection.ts'

const honeypotCss = {
	position: 'absolute' as const,
	left: '-10000px',
	width: '1px',
	height: '1px',
	overflow: 'hidden' as const,
}

export function renderHoneypot(options: { class?: string } = {}) {
	return (
		<input
			type="text"
			name={honeypotFieldName}
			tabIndex={-1}
			aria-hidden="true"
			readOnly
			class={options.class}
			{...passwordManagerIgnoreProps}
			mix={css(honeypotCss)}
		/>
	)
}
