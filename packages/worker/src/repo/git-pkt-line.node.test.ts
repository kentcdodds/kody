import { expect, test } from 'vitest'
import {
	buildUploadPackAdvertisement,
	encodeGitFlushPkt,
	encodeGitPktLine,
	extractUploadPackWantOids,
	rewriteUploadPackAdvertisement,
	uploadPackWantsOnlySnapshot,
} from './git-pkt-line.ts'

test('encodeGitPktLine prefixes the payload with a 4-byte hex length', () => {
	expect(encodeGitPktLine('# service=git-upload-pack\n')).toBe(
		'001e# service=git-upload-pack\n',
	)
	expect(encodeGitFlushPkt()).toBe('0000')
})

test('buildUploadPackAdvertisement advertises only the published snapshot on HEAD and the default branch', () => {
	const commit = '0123456789abcdef0123456789abcdef01234567'
	const body = new TextDecoder().decode(
		buildUploadPackAdvertisement({
			commit,
			defaultBranch: 'main',
			agent: 'kody-public-git',
		}),
	)
	expect(body.startsWith('001e# service=git-upload-pack\n0000')).toBe(true)
	expect(body).toContain(`${commit} HEAD\0`)
	expect(body).toContain(`symref=HEAD:refs/heads/main`)
	expect(body).toContain('allow-reachable-sha1-in-want')
	expect(body).toContain(`${commit} refs/heads/main\n`)
	expect(body.endsWith('0000')).toBe(true)
	// No other branch names should appear.
	expect(body).not.toContain('refs/heads/develop')
})

test('rewriteUploadPackAdvertisement keeps upstream capabilities and pins refs to the snapshot', () => {
	const live = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	const published = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	const upstream =
		encodeGitPktLine('# service=git-upload-pack\n') +
		encodeGitFlushPkt() +
		encodeGitPktLine(
			`${live} HEAD\0multi_ack thin-pack side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=git/artifacts\n`,
		) +
		encodeGitPktLine(`${live} refs/heads/main\n`) +
		encodeGitPktLine(`${live} refs/heads/feature\n`) +
		encodeGitFlushPkt()

	const rewritten = new TextDecoder().decode(
		rewriteUploadPackAdvertisement({
			upstreamBody: new TextEncoder().encode(upstream),
			commit: published,
			defaultBranch: 'main',
			agent: 'kody-public-git',
		}),
	)

	expect(rewritten).toContain(`${published} HEAD\0`)
	expect(rewritten).toContain('multi_ack')
	expect(rewritten).toContain('thin-pack')
	expect(rewritten).toContain('side-band-64k')
	expect(rewritten).toContain('allow-reachable-sha1-in-want')
	expect(rewritten).toContain('allow-tip-sha1-in-want')
	expect(rewritten).toContain('agent=kody-public-git')
	expect(rewritten).toContain(`${published} refs/heads/main\n`)
	expect(rewritten).not.toContain(live)
	expect(rewritten).not.toContain('refs/heads/feature')
})

test('uploadPackWantsOnlySnapshot accepts the published oid and rejects others', () => {
	const published = '0123456789abcdef0123456789abcdef01234567'
	const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	const allowed =
		encodeGitPktLine(
			`want ${published} multi_ack side-band-64k ofs-delta agent=git/2.45.0\n`,
		) +
		encodeGitPktLine('want ' + published + '\n') +
		encodeGitFlushPkt() +
		encodeGitPktLine('done\n')
	const rejected =
		encodeGitPktLine(`want ${other}\n`) +
		encodeGitFlushPkt() +
		encodeGitPktLine('done\n')

	expect(extractUploadPackWantOids(new TextEncoder().encode(allowed))).toEqual([
		published,
		published,
	])
	expect(
		uploadPackWantsOnlySnapshot({
			body: new TextEncoder().encode(allowed),
			snapshotCommit: published,
		}),
	).toBe(true)
	expect(
		uploadPackWantsOnlySnapshot({
			body: new TextEncoder().encode(rejected),
			snapshotCommit: published,
		}),
	).toBe(false)
})
