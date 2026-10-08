import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { PasswordRevealInput } from '#client/password-reveal-input.tsx'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'

test('password reveal input starts hidden with an accessible toggle', async () => {
	const html = await renderToString(
		jsx(PasswordRevealInput, {
			id: 'auth-password',
			name: 'password',
			required: true,
			autoComplete: 'current-password',
			'data-field-ring': true,
		}),
	)

	expect(html).toMatch(/<input[^>]*type="password"/)
	expect(html).toMatch(/id="auth-password"/)
	expect(html).toMatch(/name="password"/)
	expect(html).toMatch(/autocomplete="current-password"/)
	expect(html).toMatch(/type="button"/)
	expect(html).toMatch(/aria-label="Show password"/)
	expect(html).toMatch(/aria-pressed="false"/)
	expect(html).toContain('>Show<')
	expect(html).not.toMatch(/type="submit"/)
})

test('controlled reveal shows text and pressed state', async () => {
	const html = await renderToString(
		jsx(PasswordRevealInput, {
			name: 'value',
			revealNoun: 'secret value',
			revealed: true,
			onRevealedChange: () => {},
			value: 'super-secret',
			...passwordManagerIgnoreProps,
			'data-field': 'secret-value',
			'data-testid': 'connect-secret-set-value',
		}),
	)

	expect(html).toMatch(/<input[^>]*type="text"/)
	expect(html).toMatch(/aria-label="Hide secret value"/)
	expect(html).toMatch(/aria-pressed="true"/)
	expect(html).toContain('>Hide<')
	expect(html).toMatch(/data-field="secret-value"/)
	expect(html).toMatch(/data-testid="connect-secret-set-value"/)
	expect(html).toMatch(/data-1p-ignore/)
	expect(html).toMatch(/value="super-secret"/)
})
