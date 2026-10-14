/**
 * Shared attributes for permanent handle / slug inputs in the web UI.
 * Pair with `noValidate` on the form so native constraint validation cannot
 * dead-end submit (Sentry KODY-9A); JS owns blocking checks via handle-rules.
 */

import {
	handleFormatHint,
	handleHtmlPattern,
	handleHtmlPatternCaseInsensitive,
	handleMaxLength,
	handleMinLength,
} from '@kody-internal/shared/handle-rules.ts'

export type PermanentHandleInputOptions = {
	/**
	 * Signup allows mixed case in the field and lowercases on submit; org
	 * handle fields already force lowercase on input.
	 */
	caseInsensitivePattern?: boolean
}

export function permanentHandleInputProps(
	options: PermanentHandleInputOptions = {},
) {
	return {
		autoCapitalize: 'none' as const,
		autoCorrect: 'off' as const,
		spellCheck: false as const,
		minLength: handleMinLength,
		maxLength: handleMaxLength,
		pattern: options.caseInsensitivePattern
			? handleHtmlPatternCaseInsensitive
			: handleHtmlPattern,
		title: handleFormatHint,
	}
}
