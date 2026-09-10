import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	createPreviewPackage,
	formatPackageCreateReport,
	headAheadFileName,
	isLowerKebabKodyId,
	isProductionKodyOrigin,
	pushHeadAheadCommit,
	usernameFromPackageName,
} from './package-create.ts'

test('package-create builds preview URLs, reports JSON shape, and can leave HEAD ahead', async () => {
	expect(isLowerKebabKodyId('preview-pkg')).toBe(true)
	expect(isLowerKebabKodyId('@user-me/preview-pkg')).toBe(true)
	expect(isLowerKebabKodyId('pkg')).toBe(true)
	expect(isLowerKebabKodyId('Not-A-Slug')).toBe(false)
	expect(isProductionKodyOrigin('https://kody.codes')).toBe(true)
	expect(isProductionKodyOrigin('https://www.kody.codes')).toBe(true)
	expect(isProductionKodyOrigin('https://kody.codes.')).toBe(true)
	expect(isProductionKodyOrigin('https://www.kody.codes.')).toBe(true)
	expect(isProductionKodyOrigin('https://kody-pr-9.kody.workers.dev')).toBe(
		false,
	)
	expect(usernameFromPackageName('@user-me/preview-pkg', 'preview-pkg')).toBe(
		'user-me',
	)
	expect(usernameFromPackageName('preview-pkg', 'preview-pkg')).toBeNull()

	let pushedRemote: string | null = null
	const report = await createPreviewPackage({
		origin: 'https://kody-pr-9.kody.workers.dev',
		email: 'me@kentcdodds.com',
		password: 'ilikecode',
		kodyId: 'preview-pkg',
		description: 'preview fixture',
		headAhead: true,
		connect: async () => ({
			cookieHeader: 'kody_session=abc',
			client: {
				async callTool(params, options) {
					expect(params.name).toBe('execute')
					expect(options?.timeout).toBeGreaterThan(60_000)
					expect(options?.resetTimeoutOnProgress).toBe(true)
					const args = params.arguments as {
						code: string
						params: { kodyId: string; description?: string }
					}
					expect(args.code).toContain('packageGetGitRemote')
					expect(args.code).toContain('packageGet')
					expect(args.code).toContain(
						"requested.slice(requested.lastIndexOf('/') + 1)",
					)
					expect(args.params).toEqual({
						kodyId: 'preview-pkg',
						description: 'preview fixture',
						requireRemote: true,
					})
					return {
						isError: false,
						structuredContent: {
							result: {
								remote: {
									package_id: 'pkg-1',
									kody_id: 'preview-pkg',
									created: true,
									authenticated_remote:
										'https://x:token@artifacts.example/git/pkg-1',
									git_author: {
										name: 'Me',
										email: 'me@kentcdodds.com',
									},
									setup_commands: [
										"git config --local user.email -- 'me@kentcdodds.com'",
										"git config --local user.name -- 'Me'",
									],
								},
								detail: { name: '@user-me/preview-pkg' },
							},
						},
					}
				},
			},
		}),
		pushHeadAhead: async (remote) => {
			pushedRemote = remote.authenticated_remote
		},
	})

	expect(report).toMatchObject({
		ok: true,
		packageId: 'pkg-1',
		kodyId: 'preview-pkg',
		name: '@user-me/preview-pkg',
		created: true,
		username: 'user-me',
		packagePagePath: '/@user-me/preview-pkg',
		accountPackagePath: '/account/packages/pkg-1',
		packagePageUrl: 'https://kody-pr-9.kody.workers.dev/@user-me/preview-pkg',
		accountPackageUrl:
			'https://kody-pr-9.kody.workers.dev/account/packages/pkg-1',
		headAhead: true,
		cookieHeader: 'kody_session=abc',
	})
	expect(pushedRemote).toBe('https://x:token@artifacts.example/git/pkg-1')
	const recovered = await createPreviewPackage({
		origin: 'https://kody-pr-9.kody.workers.dev',
		email: 'me@kentcdodds.com',
		password: 'ilikecode',
		kodyId: 'preview-pkg',
		headAhead: false,
		connect: async () => ({
			cookieHeader: 'kody_session=abc',
			client: {
				async callTool() {
					return {
						isError: false,
						structuredContent: {
							result: {
								remote: null,
								remoteError: 'account not found',
								detail: {
									package_id: 'pkg-1',
									kody_id: 'preview-pkg',
									name: '@user-me/preview-pkg',
								},
							},
						},
					}
				},
			},
		}),
	})
	expect(recovered.packageId).toBe('pkg-1')
	expect(recovered.headAhead).toBe(false)

	const scoped = await createPreviewPackage({
		origin: 'https://kody-pr-9.kody.workers.dev',
		email: 'me@kentcdodds.com',
		password: 'ilikecode',
		kodyId: '@user-me/preview-pkg',
		headAhead: false,
		connect: async () => ({
			cookieHeader: 'kody_session=abc',
			client: {
				async callTool(params) {
					const args = params.arguments as {
						code: string
						params: { kodyId: string }
					}
					expect(args.params.kodyId).toBe('@user-me/preview-pkg')
					expect(args.code).toContain(
						"requested.slice(requested.lastIndexOf('/') + 1)",
					)
					return {
						isError: false,
						structuredContent: {
							result: {
								remote: null,
								remoteError: 'account not found',
								detail: {
									package_id: 'pkg-1',
									kody_id: 'preview-pkg',
									name: '@user-me/preview-pkg',
								},
							},
						},
					}
				},
			},
		}),
	})
	expect(scoped.packageId).toBe('pkg-1')
	expect(scoped.kodyId).toBe('preview-pkg')
	expect(scoped.name).toBe('@user-me/preview-pkg')

	expect(formatPackageCreateReport(report)).toBe(
		[
			'packageId pkg-1',
			'kodyId preview-pkg',
			'name @user-me/preview-pkg',
			'package-page https://kody-pr-9.kody.workers.dev/@user-me/preview-pkg',
			'account-page https://kody-pr-9.kody.workers.dev/account/packages/pkg-1',
			'head-ahead pushed',
		].join('\n'),
	)

	await expect(
		createPreviewPackage({
			origin: 'https://kody.codes',
			email: 'me@kentcdodds.com',
			password: 'ilikecode',
			kodyId: 'preview-pkg',
			headAhead: false,
		}),
	).rejects.toThrow(/refuses to run against https:\/\/kody\.codes/)

	await expect(
		createPreviewPackage({
			origin: 'https://kody.codes.',
			email: 'me@kentcdodds.com',
			password: 'ilikecode',
			kodyId: 'preview-pkg',
			headAhead: false,
		}),
	).rejects.toThrow(/refuses to run against https:\/\/kody\.codes/)

	await expect(
		createPreviewPackage({
			origin: 'https://kody-pr-9.kody.workers.dev',
			email: 'me@kentcdodds.com',
			password: 'ilikecode',
			kodyId: 'preview-pkg',
			headAhead: false,
			connect: async () => ({
				cookieHeader: 'kody_session=abc',
				client: {
					async callTool() {
						return {
							isError: true,
							content: [
								{
									type: 'text',
									text: 'Saved package not found for this user.',
								},
							],
							structuredContent: { error: 'missing' },
						}
					},
				},
			}),
		}),
	).rejects.toThrow(/execute failed: Saved package not found/)

	const parent = await mkdtemp(path.join(tmpdir(), 'control-kody-head-ahead-'))
	try {
		const bare = path.join(parent, 'remote.git')
		const seed = path.join(parent, 'seed')
		execFileSync('git', ['init', '--bare', bare])
		execFileSync('git', ['clone', '--quiet', bare, seed])
		execFileSync('git', ['-C', seed, 'config', 'user.email', 'me@example.com'])
		execFileSync('git', ['-C', seed, 'config', 'user.name', 'Me'])
		await writeFile(path.join(seed, 'README.md'), 'stub\n')
		execFileSync('git', ['-C', seed, 'add', 'README.md'])
		execFileSync('git', ['-C', seed, 'commit', '-m', 'init'])
		execFileSync('git', ['-C', seed, 'push', '--quiet', 'origin', 'HEAD'])

		await pushHeadAheadCommit({
			package_id: 'pkg-1',
			kody_id: 'preview-pkg',
			authenticated_remote: bare,
			git_author: { name: 'Me', email: 'me@example.com' },
			setup_commands: [
				"git config --local user.email -- 'me@example.com'",
				"git config --local user.name -- 'Me'",
			],
		})

		const log = execFileSync('git', ['--git-dir', bare, 'log', '--oneline'], {
			encoding: 'utf8',
		})
		expect(log).toMatch(/leave HEAD ahead of published/)
		const show = execFileSync(
			'git',
			['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'HEAD'],
			{ encoding: 'utf8' },
		)
		expect(show).toContain(headAheadFileName)

		await pushHeadAheadCommit({
			package_id: 'pkg-1',
			kody_id: 'preview-pkg',
			authenticated_remote: bare,
			git_author: { name: 'Me', email: 'me@example.com' },
			setup_commands: [
				"git config --local user.email -- 'me@example.com'",
				"git config --local user.name -- 'Me'",
			],
		})
		const logAfterRerun = execFileSync(
			'git',
			['--git-dir', bare, 'log', '--oneline'],
			{ encoding: 'utf8' },
		)
		expect(logAfterRerun.match(/leave HEAD ahead of published/g)).toHaveLength(
			1,
		)
	} finally {
		await rm(parent, { recursive: true, force: true })
	}
})
