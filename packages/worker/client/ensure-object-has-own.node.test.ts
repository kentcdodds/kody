import { expect, test } from 'vitest'
import { ensureObjectHasOwn } from './ensure-object-has-own.ts'

test('ensureObjectHasOwn polyfills missing hasOwn and leaves an existing implementation alone', () => {
	const objectWithoutHasOwn = {} as {
		hasOwn?: (object: object, property: PropertyKey) => boolean
	}

	ensureObjectHasOwn(objectWithoutHasOwn)

	expect(typeof objectWithoutHasOwn.hasOwn).toBe('function')
	expect(objectWithoutHasOwn.hasOwn!({ own: 1 }, 'own')).toBe(true)
	expect(objectWithoutHasOwn.hasOwn!({ own: 1 }, 'missing')).toBe(false)
	expect(
		objectWithoutHasOwn.hasOwn!(Object.create({ inherited: 1 }), 'inherited'),
	).toBe(false)

	const nullProto = Object.create(null) as { own?: number }
	nullProto.own = 1
	expect(objectWithoutHasOwn.hasOwn!(nullProto, 'own')).toBe(true)
	expect(objectWithoutHasOwn.hasOwn!(nullProto, 'toString')).toBe(false)

	const existing = () => true
	const objectWithHasOwn = { hasOwn: existing }

	ensureObjectHasOwn(objectWithHasOwn)
	expect(objectWithHasOwn.hasOwn).toBe(existing)
	expect(objectWithHasOwn.hasOwn({}, 'x')).toBe(true)
})
