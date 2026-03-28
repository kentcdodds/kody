import { expect, test } from 'vitest'
import { formatConnectorConfigFailureMessage } from './connect-secret-errors.ts'

test('reports rollback when secret rollback completed', () => {
	const message = formatConnectorConfigFailureMessage(
		new Error('Config update exploded.'),
		{ secretRolledBack: true },
	)

	expect(message).toBe(
		'Connector configuration failed and the secret was rolled back. Config update exploded.',
	)
})

test('does not claim rollback when no connector rollback ran', () => {
	const message = formatConnectorConfigFailureMessage(
		new Error('Config update exploded.'),
		{ secretRolledBack: false },
	)

	expect(message).toBe(
		'Connector configuration failed after the secret was saved. Config update exploded.',
	)
})
