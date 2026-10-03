import { expect, test } from 'vitest'
import {
	checkInstalledLockfile,
	findInstalledLockfileMismatches,
	formatInstalledLockfileError,
	inspectInstalledLockfile,
} from './check-installed-lockfile.ts'

test('installed lockfile check flags stale or missing root dependencies', () => {
	const lock = {
		packages: {
			'': {
				dependencies: { remix: '3.0.0-rc.4' },
				devDependencies: { vitest: '^4.0.0' },
			},
			'node_modules/remix': { version: '3.0.0-rc.4' },
			'node_modules/vitest': { version: '4.0.1' },
		},
	}

	expect(
		findInstalledLockfileMismatches({
			lock,
			readInstalledVersion: (name) =>
				name === 'remix' ? '3.0.0-rc.2' : '4.0.1',
		}),
	).toEqual([
		{
			name: 'remix',
			lockedVersion: '3.0.0-rc.4',
			installedVersion: '3.0.0-rc.2',
		},
	])

	expect(
		inspectInstalledLockfile({
			lock,
			readInstalledVersion: (name) =>
				name === 'remix' ? '3.0.0-rc.2' : '4.0.1',
		}),
	).toEqual({
		ok: false,
		detail: formatInstalledLockfileError([
			{
				name: 'remix',
				lockedVersion: '3.0.0-rc.4',
				installedVersion: '3.0.0-rc.2',
			},
		]),
	})

	expect(
		inspectInstalledLockfile({
			lock,
			readInstalledVersion: (name) =>
				name === 'remix' ? '3.0.0-rc.4' : '4.0.1',
		}),
	).toEqual({
		ok: true,
		detail: 'installed root dependencies match package-lock.json',
	})

	expect(
		findInstalledLockfileMismatches({
			lock,
			readInstalledVersion: () => null,
		}),
	).toEqual([
		{
			name: 'remix',
			lockedVersion: '3.0.0-rc.4',
			installedVersion: null,
		},
		{
			name: 'vitest',
			lockedVersion: '4.0.1',
			installedVersion: null,
		},
	])
})

test('installed lockfile check against this repo is clean', async () => {
	const result = await checkInstalledLockfile()
	expect(result.ok).toBe(true)
})
