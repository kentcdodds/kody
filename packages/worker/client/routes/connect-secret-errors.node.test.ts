import { expect, test } from 'vitest'
import { formatConnectorConfigFailureMessage } from './connect-secret-errors.ts'

test('connector config failure messages explain what happened to the secret', () => {
	const rollbackMessage = formatConnectorConfigFailureMessage(
		new Error('Config update exploded.'),
		{ secretRolledBack: true },
	)
	expect(rollbackMessage).toContain('secret was rolled back')
	expect(rollbackMessage).toContain('Config update exploded.')

	const savedMessage = formatConnectorConfigFailureMessage(
		new Error('Config update exploded.'),
		{ secretRolledBack: false },
	)
	expect(savedMessage).toContain('secret was saved')
	expect(savedMessage).toContain('Config update exploded.')
	expect(savedMessage).not.toContain('rolled back')

	const updatedMessage = formatConnectorConfigFailureMessage(
		new Error('Config update exploded.'),
		{ secretRolledBack: false, updatedSecretRetained: true },
	)
	expect(updatedMessage).toContain('secret was updated')
	expect(updatedMessage).toContain('Config update exploded.')
	expect(updatedMessage).not.toContain('secret was saved')
})
