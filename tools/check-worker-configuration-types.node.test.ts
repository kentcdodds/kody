import { expect, test } from 'vitest'
import {
	normalizeWorkerConfigurationTypes,
	workerConfigurationTypesCheckPath,
	workerConfigurationTypesPath,
} from './generate-worker-configuration-types.ts'
import { workerConfigurationTypesDrift } from './check-worker-configuration-types.ts'

test('worker configuration type check ignores the temp output path', () => {
	const generated = `// wrangler types ${workerConfigurationTypesCheckPath}\nexport {}\n`
	expect(
		normalizeWorkerConfigurationTypes(
			generated,
			workerConfigurationTypesCheckPath,
			workerConfigurationTypesPath,
		),
	).toBe(`// wrangler types ${workerConfigurationTypesPath}\nexport {}\n`)
})

test('worker configuration type drift samples the first mismatched lines', () => {
	expect(workerConfigurationTypesDrift('a\nb\n', 'a\nb\n')).toBeNull()
	expect(workerConfigurationTypesDrift('a\nb\n', 'a\nc\n')).toEqual([
		'line 2\n- b\n+ c',
	])
})
