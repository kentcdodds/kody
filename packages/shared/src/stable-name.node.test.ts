import { expect, test } from 'vitest'
import {
	isValidKodyInstanceName,
	normalizeKodyInstanceName,
} from './stable-name.ts'

test('normalizeKodyInstanceName trims and lowercases', () => {
	expect(normalizeKodyInstanceName('  Home-Hub  ')).toBe('home-hub')
})

test('isValidKodyInstanceName accepts lowercase dashed names', () => {
	expect(isValidKodyInstanceName('home')).toBe(true)
	expect(isValidKodyInstanceName('home-hub')).toBe(true)
	expect(isValidKodyInstanceName('a1')).toBe(true)
})

test('isValidKodyInstanceName rejects invalid shapes', () => {
	expect(isValidKodyInstanceName('')).toBe(false)
	expect(isValidKodyInstanceName('-home')).toBe(false)
	expect(isValidKodyInstanceName('home-')).toBe(false)
	expect(isValidKodyInstanceName('home_hub')).toBe(false)
	expect(isValidKodyInstanceName('a'.repeat(65))).toBe(false)
})
