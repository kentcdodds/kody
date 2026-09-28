/**
 * Builds `public/music/personal-software-soundtrack.m4a`: an edit of the Suno
 * track "Personal software" (D major, about 122 BPM) retimed onto the video's
 * 120 BPM grid, under the opening's sound design. The UI one-shots are not in
 * here; `src/components/sound-effects.tsx` places them on the same cue frames.
 *
 * Needs ffmpeg built with librubberband on PATH (Homebrew's ffmpeg has it).
 * The source downloads once into `.cache/`.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openingCues } from '../src/opening-cues.ts'
import { bar, durationInFrames, fps } from '../src/timing.ts'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceUrl =
	'https://dl.dropboxusercontent.com/scl/fi/63u8tz933toxvzstwiskx/Personal-software.mp3?rlkey=dyv09qxhx129rwz7ldasj2wkv&raw=1'
const sourceSha256 =
	'79a8ef5eb38ea788ad4050cd74937760b4328a1de3c6ab20f1e419090e000e86'
const sourcePath = path.join(root, '.cache', 'personal-software-suno.mp3')
const outputPath = path.join(
	root,
	'public',
	'music',
	'personal-software-soundtrack.m4a',
)

const sampleRate = 48_000
const totalSeconds = durationInFrames / fps
const totalSamples = Math.round(totalSeconds * sampleRate)
const targetBeat = 0.5
const seconds = (frame: number) => frame / fps

type Stereo = { left: Float32Array; right: Float32Array }

function stereo(length = totalSamples): Stereo {
	return { left: new Float32Array(length), right: new Float32Array(length) }
}

async function ensureSource() {
	if (!existsSync(sourcePath)) {
		mkdirSync(path.dirname(sourcePath), { recursive: true })
		const response = await fetch(sourceUrl)
		if (!response.ok) throw new Error(`Download failed: ${response.status}`)
		writeFileSync(sourcePath, Buffer.from(await response.arrayBuffer()))
	}
	const hash = createHash('sha256')
		.update(readFileSync(sourcePath))
		.digest('hex')
	if (hash !== sourceSha256) {
		throw new Error(
			`Unexpected source hash ${hash}; the cue times below are measured against ${sourceSha256}.`,
		)
	}
}

function ffmpeg(args: Array<string>, input?: Buffer) {
	return execFileSync('ffmpeg', ['-v', 'error', ...args], {
		input,
		maxBuffer: 1 << 30,
	})
}

function toStereo(raw: Buffer): Stereo {
	const interleaved = new Float32Array(
		raw.buffer,
		raw.byteOffset,
		raw.byteLength / 4,
	)
	const frames = interleaved.length / 2
	const out = stereo(frames)
	for (let index = 0; index < frames; index++) {
		out.left[index] = interleaved[index * 2]!
		out.right[index] = interleaved[index * 2 + 1]!
	}
	return out
}

function toInterleaved(audio: Stereo) {
	const out = new Float32Array(audio.left.length * 2)
	for (let index = 0; index < audio.left.length; index++) {
		out[index * 2] = audio.left[index]!
		out[index * 2 + 1] = audio.right[index]!
	}
	return Buffer.from(out.buffer)
}

const pcmArgs = ['-f', 'f32le', '-ac', '2', '-ar', String(sampleRate)]

/**
 * Source cut points, measured on the kick attacks of the Suno master. Each
 * section drifts a little from Suno's nominal tempo, so each gets its own
 * beat length and stretch ratio.
 */
const segments = [
	{
		name: 'drop',
		sourceAt: 19.922,
		sourceBeat: 0.4931,
		lead: 1.1,
		fadeFrom: seconds(openingCues.ugh) + 0.6,
		videoAt: seconds(bar(6)),
		videoUntil: seconds(bar(9)),
	},
	{
		name: 'pre-chorus into chorus',
		sourceAt: 112.2646,
		sourceBeat: 0.4886,
		lead: 0.02,
		fadeFrom: seconds(bar(9)) - 0.02,
		videoAt: seconds(bar(9)),
		videoUntil: seconds(bar(14)),
	},
	{
		name: 'final hit',
		sourceAt: 165.182,
		sourceBeat: targetBeat,
		lead: 0.02,
		fadeFrom: seconds(bar(14)) - 0.02,
		videoAt: seconds(bar(14)),
		videoUntil: totalSeconds,
	},
] as const

const seamSeconds = 0.02

function equalPower(value: number) {
	return Math.sin((Math.min(1, Math.max(0, value)) * Math.PI) / 2)
}

function renderMusic(source: Stereo) {
	const music = stereo()
	for (const segment of segments) {
		const tempo = segment.sourceBeat / targetBeat
		const sourceFrom = segment.sourceAt - segment.lead
		const sourceSeconds =
			(segment.videoUntil - segment.videoAt + seamSeconds * 2) * tempo +
			segment.lead
		const start = Math.round(sourceFrom * sampleRate)
		const length = Math.min(
			Math.round(sourceSeconds * sampleRate),
			source.left.length - start,
		)
		const slice: Stereo = {
			left: source.left.subarray(start, start + length),
			right: source.right.subarray(start, start + length),
		}
		const filter =
			tempo === 1
				? 'anull'
				: `rubberband=tempo=${tempo}:transients=crisp:channels=together:pitchq=quality`
		const stretched = toStereo(
			ffmpeg(
				[...pcmArgs, '-i', 'pipe:0', '-af', filter, ...pcmArgs, 'pipe:1'],
				toInterleaved(slice),
			),
		)
		const videoFrom = segment.videoAt - segment.lead / tempo
		const offset = Math.round(videoFrom * sampleRate)
		for (let index = 0; index < stretched.left.length; index++) {
			const target = offset + index
			if (target < 0 || target >= totalSamples) continue
			const time = target / sampleRate
			const leadIn = equalPower(
				(time - segment.fadeFrom) / (segment.videoAt - segment.fadeFrom),
			)
			const tail =
				segment.videoUntil >= totalSeconds
					? 1
					: equalPower(1 - (time - segment.videoUntil) / seamSeconds)
			const gain = leadIn * tail
			if (gain <= 0) continue
			music.left[target]! += stretched.left[index]! * gain
			music.right[target]! += stretched.right[index]! * gain
		}
	}
	return music
}

function mulberry32(seed: number) {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const random = mulberry32(0x6b6f6479)
const noise = () => random() * 2 - 1

/** Topology-preserving state-variable filter (Simper). */
function createFilter() {
	let ic1 = 0
	let ic2 = 0
	return (input: number, cutoff: number, resonance = 0.2) => {
		const g = Math.tan(
			(Math.PI * Math.min(cutoff, sampleRate * 0.45)) / sampleRate,
		)
		const k = 2 - 2 * resonance
		const a1 = 1 / (1 + g * (g + k))
		const a2 = g * a1
		const a3 = g * a2
		const v3 = input - ic2
		const v1 = a1 * ic1 + a2 * v3
		const v2 = ic2 + a2 * ic1 + a3 * v3
		ic1 = 2 * v1 - ic1
		ic2 = 2 * v2 - ic2
		return { low: v2, band: v1, high: input - k * v1 - v2 }
	}
}

function add(bus: Stereo, time: number, value: number, pan = 0) {
	const index = Math.round(time * sampleRate)
	if (index < 0 || index >= totalSamples) return
	bus.left[index]! += value * Math.cos(((pan + 1) * Math.PI) / 4)
	bus.right[index]! += value * Math.sin(((pan + 1) * Math.PI) / 4)
}

/** A wooden clock tick; `tock` is the lower, rounder half. */
function renderTick(bus: Stereo, at: number, tock: boolean, gain: number) {
	const filter = createFilter()
	const pitch = tock ? 1250 : 2350
	const length = 0.05
	for (let n = 0; n < length * sampleRate; n++) {
		const t = n / sampleRate
		const click = filter(noise(), tock ? 1800 : 3600, 0.75).band
		const body = Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t / 0.012)
		const value = (click * Math.exp(-t / 0.004) * 0.9 + body * 0.6) * gain
		add(bus, at + t, value, tock ? 0.12 : -0.12)
	}
}

/**
 * Tick-tock on the video's grid: quarter notes while one app gets built,
 * eighths once it is "again", sixteenths for the last "and again…". It runs
 * a little past "Ugh" so the tape stop has material to slow down.
 */
function renderClock(bus: Stereo) {
	const eighthsFrom = seconds(openingCues.again)
	const sixteenthsFrom = seconds(openingCues.andAgain[1])
	const stopAt = seconds(openingCues.ugh) + 0.3
	let time = 0
	let count = 0
	while (time < stopAt) {
		const step =
			time >= sixteenthsFrom ? 0.125 : time >= eighthsFrom ? 0.25 : 0.5
		const swell = Math.min(1, 0.55 + (time / stopAt) * 0.6)
		renderTick(bus, time, count % 2 === 1, 0.16 * swell)
		count++
		time = Math.round((time + step) / step) * step
	}
}

/**
 * A low D minor bed (D2, A2, D3, F3): barely there for the first app, then
 * creeping up in level and brightness under the repeats.
 */
function renderDrone(bus: Stereo) {
	const creepFrom = seconds(openingCues.needAnother) - 0.2
	const until = seconds(openingCues.ugh) + 0.3
	const voices = [73.42, 110, 146.83, 174.61].map((frequency, index) => ({
		frequency,
		phase: index * 0.23,
		filter: createFilter(),
		pan: [-0.3, 0.3, -0.15, 0.15][index]!,
	}))
	for (let n = 0; n < until * sampleRate; n++) {
		const t = n / sampleRate
		const creep = Math.max(0, (t - creepFrom) / (until - creepFrom)) ** 2
		const envelope = Math.min(1, t / 0.8) * (0.022 + creep * 0.08)
		const cutoff = 170 + creep * 1300
		for (const voice of voices) {
			voice.phase +=
				(voice.frequency * (1 + Math.sin(t * 0.7) * 0.002)) / sampleRate
			voice.phase -= Math.floor(voice.phase)
			const saw = voice.phase * 2 - 1
			add(bus, t, voice.filter(saw, cutoff, 0.35).low * envelope, voice.pan)
		}
	}
}

/** Tape stop: from `at`, playback slows to a halt over `length` seconds. */
function tapeStop(bus: Stereo, at: number, length: number) {
	const start = Math.round(at * sampleRate)
	const copy = { left: bus.left.slice(), right: bus.right.slice() }
	let position = start
	for (let index = start; index < totalSamples; index++) {
		const t = (index - start) / sampleRate
		if (t >= length) {
			bus.left[index] = 0
			bus.right[index] = 0
			continue
		}
		const rate = (1 - t / length) ** 2
		position += rate
		const whole = Math.floor(position)
		const fraction = position - whole
		const fade = 1 - (t / length) ** 3
		for (const channel of ['left', 'right'] as const) {
			const a = copy[channel][whole] ?? 0
			const b = copy[channel][whole + 1] ?? 0
			bus[channel][index] = (a + (b - a) * fraction) * fade
		}
	}
}

/** "Ugh": a low buzzy voice that sags from D3 to D1. */
function renderDeflate(bus: Stereo, at: number) {
	const filter = createFilter()
	const length = 0.85
	let phase = 0
	for (let n = 0; n < length * sampleRate; n++) {
		const t = n / sampleRate
		const glide = t / length
		const frequency =
			146.83 * 2 ** (-2 * glide ** 1.6) * (1 + Math.sin(t * 38) * 0.012)
		phase += frequency / sampleRate
		phase -= Math.floor(phase)
		const square = phase < 0.42 ? 1 : -1
		const envelope = Math.min(1, t / 0.02) * (1 - glide) ** 1.4
		const cutoff = 1500 * (1 - glide) + 160
		add(bus, at + t, filter(square, cutoff, 0.55).low * envelope * 0.16)
	}
}

/** Reverse-cymbal swell that cuts off on the drop. */
function renderSwell(bus: Stereo, from: number, until: number) {
	const filter = createFilter()
	for (let n = 0; n < (until - from) * sampleRate; n++) {
		const t = n / sampleRate
		const rise = t / (until - from)
		const cutoff = 700 + rise ** 2 * 9000
		const value = filter(noise(), cutoff, 0.3).high * rise ** 3 * 0.2
		add(bus, from + t, value, Math.sin(t * 9) * 0.3)
	}
}

/** Sub drop under the lantern lighting and the tagline. */
function renderBoom(bus: Stereo, at: number, gain: number) {
	let phase = 0
	for (let n = 0; n < 1.2 * sampleRate; n++) {
		const t = n / sampleRate
		phase += (73.42 * 2 ** (-0.8 * Math.min(1, t / 0.6))) / sampleRate
		const envelope = Math.min(1, t / 0.004) * Math.exp(-t / 0.45)
		add(bus, at + t, Math.sin(2 * Math.PI * phase) * envelope * gain)
	}
}

function renderOpening() {
	const ugh = seconds(openingCues.ugh)
	const bed = stereo()
	renderClock(bed)
	renderDrone(bed)
	tapeStop(bed, ugh, 0.6)
	renderDeflate(bed, ugh + 0.04)
	renderSwell(bed, 9.2, seconds(bar(6)))
	renderBoom(bed, seconds(bar(6)), 0.32)
	renderBoom(bed, seconds(bar(14)), 0.26)
	return bed
}

/** Integrated loudness (LUFS) of a raw f32 stereo file, from ffmpeg's ebur128. */
function integratedLoudness(file: string) {
	const result = spawnSync(
		'ffmpeg',
		[
			'-hide_banner',
			'-nostats',
			...pcmArgs,
			'-i',
			file,
			'-af',
			'ebur128=framelog=quiet',
			'-f',
			'null',
			'-',
		],
		{ encoding: 'utf8' },
	)
	const match = /Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(
		result.stderr,
	)
	if (!match) throw new Error(`Could not read loudness:\n${result.stderr}`)
	return Number(match[1])
}

const targetLufs = -14

async function main() {
	await ensureSource()
	const source = toStereo(ffmpeg(['-i', sourcePath, ...pcmArgs, 'pipe:1']))
	const music = renderMusic(source)
	const bed = renderOpening()
	const mix = stereo()
	for (let index = 0; index < totalSamples; index++) {
		mix.left[index] = music.left[index]! + bed.left[index]!
		mix.right[index] = music.right[index]! + bed.right[index]!
	}
	const mixPath = path.join(root, '.cache', 'soundtrack-mix.f32')
	writeFileSync(mixPath, toInterleaved(mix))
	const gain = targetLufs - integratedLoudness(mixPath)
	mkdirSync(path.dirname(outputPath), { recursive: true })
	ffmpeg([
		'-y',
		...pcmArgs,
		'-i',
		mixPath,
		'-af',
		`volume=${gain.toFixed(2)}dB,alimiter=limit=0.84:attack=2:release=60:level=disabled`,
		'-c:a',
		'aac',
		'-b:a',
		'256k',
		outputPath,
	])
	console.log(
		`Wrote ${path.relative(root, outputPath)} (mix gain ${gain.toFixed(2)} dB)`,
	)
}

await main()
