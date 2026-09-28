/**
 * Original score for the piece, synthesized from code so the license is the
 * repo's own. Deterministic: same code, same WAV. 120 BPM with one bar per
 * two seconds, so the drop on bar 6 lands on frame 300 at 30fps, where the
 * lantern lights. Tempo, bar map, and duration must match `src/timing.ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sampleRate = 48_000
const bpm = 120
const beatSeconds = 60 / bpm
const barSeconds = beatSeconds * 4
const durationSeconds = 29.5
const totalSamples = Math.round(durationSeconds * sampleRate)

const outputPath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'public',
	'music',
	'kody-warm-drive.wav',
)

type Bus = { left: Float32Array; right: Float32Array }

function createBus(): Bus {
	return {
		left: new Float32Array(totalSamples),
		right: new Float32Array(totalSamples),
	}
}

const buses = {
	pad: createBus(),
	keys: createBus(),
	bass: createBus(),
	drums: createBus(),
	fx: createBus(),
	reverbSend: createBus(),
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

function midiToFrequency(midi: number) {
	return 440 * 2 ** ((midi - 69) / 12)
}

function barTime(bar: number, beat = 0) {
	return (bar - 1) * barSeconds + beat * beatSeconds
}

function write(bus: Bus, index: number, value: number, pan: number, send = 0) {
	if (index < 0 || index >= totalSamples) return
	const leftGain = Math.cos(((pan + 1) * Math.PI) / 4)
	const rightGain = Math.sin(((pan + 1) * Math.PI) / 4)
	bus.left[index]! += value * leftGain
	bus.right[index]! += value * rightGain
	if (send > 0) {
		buses.reverbSend.left[index]! += value * leftGain * send
		buses.reverbSend.right[index]! += value * rightGain * send
	}
}

/** Topology-preserving state-variable filter (Simper). */
function createFilter() {
	let ic1 = 0
	let ic2 = 0
	return (input: number, cutoff: number, resonance: number) => {
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

function polyBlep(phase: number, increment: number) {
	if (phase < increment) {
		const t = phase / increment
		return t + t - t * t - 1
	}
	if (phase > 1 - increment) {
		const t = (phase - 1) / increment
		return t * t + t + t + 1
	}
	return 0
}

function renderPadChord(input: {
	notes: Array<number>
	start: number
	duration: number
	gain: number
	cutoffFrom: number
	cutoffTo: number
	attack?: number
	release?: number
}) {
	const attack = input.attack ?? 0.35
	const release = input.release ?? 0.9
	const detunes = [-0.11, -0.04, 0.05, 0.12]
	const startIndex = Math.round(input.start * sampleRate)
	const length = Math.round((input.duration + release) * sampleRate)
	for (const [noteIndex, note] of input.notes.entries()) {
		for (const [voiceIndex, detune] of detunes.entries()) {
			const frequency = midiToFrequency(note + detune)
			const increment = frequency / sampleRate
			let phase = random()
			const filter = createFilter()
			const pan =
				((voiceIndex / (detunes.length - 1)) * 2 - 1) * 0.7 +
				(noteIndex % 2 === 0 ? -0.08 : 0.08)
			for (let i = 0; i < length; i++) {
				const t = i / sampleRate
				const env =
					t < attack
						? t / attack
						: t < input.duration
							? 1
							: Math.max(0, 1 - (t - input.duration) / release)
				const progress = Math.min(1, t / Math.max(0.01, input.duration))
				const cutoff =
					input.cutoffFrom +
					(input.cutoffTo - input.cutoffFrom) * progress +
					180 * Math.sin(2 * Math.PI * 0.25 * (input.start + t))
				let saw = 2 * phase - 1
				saw -= polyBlep(phase, increment)
				phase += increment
				if (phase >= 1) phase -= 1
				const filtered = filter(saw, cutoff, 0.18).low
				write(
					buses.pad,
					startIndex + i,
					filtered * env * env * input.gain * 0.06,
					pan,
					0.35,
				)
			}
		}
	}
}

/** Two-operator FM electric piano: warm body, soft bell on the attack. */
function renderKey(input: {
	note: number
	start: number
	decay: number
	gain: number
	pan: number
	brightness?: number
	send?: number
}) {
	const frequency = midiToFrequency(input.note)
	const startIndex = Math.round(input.start * sampleRate)
	const length = Math.round((input.decay * 4 + 0.05) * sampleRate)
	const brightness = input.brightness ?? 1
	const filter = createFilter()
	let carrierPhase = 0
	let modulatorPhase = 0
	let tinePhase = 0
	for (let i = 0; i < length; i++) {
		const t = i / sampleRate
		const attack = Math.min(1, t / 0.004)
		const env = attack * Math.exp(-t / input.decay)
		const index = brightness * (0.35 + 2.1 * Math.exp(-t / 0.09))
		const modulator = Math.sin(2 * Math.PI * modulatorPhase) * index
		const tine = Math.sin(2 * Math.PI * tinePhase) * 0.18 * Math.exp(-t / 0.03)
		const sample = Math.sin(2 * Math.PI * carrierPhase + modulator) + tine
		carrierPhase += frequency / sampleRate
		modulatorPhase += frequency / sampleRate
		tinePhase += (frequency * 7.02) / sampleRate
		const filtered = filter(sample, 1800 + 3200 * brightness, 0.1).low
		write(
			buses.keys,
			startIndex + i,
			filtered * env * input.gain * 0.16,
			input.pan,
			input.send ?? 0.28,
		)
	}
}

function renderBassNote(input: {
	note: number
	start: number
	duration: number
	gain: number
}) {
	const frequency = midiToFrequency(input.note)
	const startIndex = Math.round(input.start * sampleRate)
	const length = Math.round((input.duration + 0.06) * sampleRate)
	const filter = createFilter()
	let phase = 0
	for (let i = 0; i < length; i++) {
		const t = i / sampleRate
		const attack = Math.min(1, t / 0.006)
		const release =
			t > input.duration ? Math.max(0, 1 - (t - input.duration) / 0.06) : 1
		const env = attack * release * (0.75 + 0.25 * Math.exp(-t / 0.12))
		const tone =
			Math.sin(2 * Math.PI * phase) +
			0.35 * Math.sin(4 * Math.PI * phase) +
			0.12 * Math.sin(6 * Math.PI * phase)
		phase += frequency / sampleRate
		const warm = Math.tanh(tone * 1.4)
		const filtered = filter(warm, 700 + 900 * Math.exp(-t / 0.08), 0.15).low
		write(buses.bass, startIndex + i, filtered * env * input.gain * 0.3, 0)
	}
}

const kickTimes: Array<number> = []

function renderKick(start: number, gain: number) {
	kickTimes.push(start)
	const startIndex = Math.round(start * sampleRate)
	const length = Math.round(0.45 * sampleRate)
	let phase = 0
	for (let i = 0; i < length; i++) {
		const t = i / sampleRate
		const frequency = 46 + 110 * Math.exp(-t / 0.028)
		phase += frequency / sampleRate
		const body = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.2)
		const click = noise() * Math.exp(-t / 0.0015) * 0.25
		write(
			buses.drums,
			startIndex + i,
			Math.tanh((body + click) * 1.6) * gain * 0.55,
			0,
		)
	}
}

function renderClap(start: number, gain: number) {
	const startIndex = Math.round(start * sampleRate)
	const length = Math.round(0.35 * sampleRate)
	const filter = createFilter()
	for (let i = 0; i < length; i++) {
		const t = i / sampleRate
		const bursts = [0, 0.009, 0.019].reduce(
			(sum, offset) =>
				t >= offset ? sum + Math.exp(-(t - offset) / 0.006) : sum,
			0,
		)
		const env = bursts * 0.5 + Math.exp(-t / 0.11) * 0.55
		const band = filter(noise(), 1500, 0.35).band
		write(buses.drums, startIndex + i, band * env * gain * 0.4, 0.05, 0.4)
	}
}

function renderHat(start: number, gain: number, open: boolean, pan: number) {
	const startIndex = Math.round(start * sampleRate)
	const decay = open ? 0.13 : 0.028
	const length = Math.round(decay * 6 * sampleRate)
	const filter = createFilter()
	const filterTwo = createFilter()
	for (let i = 0; i < length; i++) {
		const t = i / sampleRate
		const high = filterTwo(filter(noise(), 7500, 0.05).high, 9000, 0.1).high
		write(
			buses.drums,
			startIndex + i,
			high * Math.exp(-t / decay) * gain * 0.13,
			pan,
			0.08,
		)
	}
}

function renderRiser(start: number, duration: number, gain: number) {
	const startIndex = Math.round(start * sampleRate)
	const length = Math.round(duration * sampleRate)
	const filter = createFilter()
	for (let i = 0; i < length; i++) {
		const progress = i / length
		const cutoff = 300 * (6000 / 300) ** progress
		const band = filter(noise(), cutoff, 0.55).band
		const env = progress ** 2.2
		const pan = Math.sin(progress * Math.PI * 6) * 0.4
		write(buses.fx, startIndex + i, band * env * gain * 0.22, pan, 0.4)
	}
}

function renderShimmer(start: number, duration: number, gain: number) {
	const startIndex = Math.round(start * sampleRate)
	const length = Math.round(duration * sampleRate)
	const filter = createFilter()
	for (let i = 0; i < length; i++) {
		const t = i / sampleRate
		const high = filter(noise(), 6500, 0.1).high
		const env = Math.min(1, t / 0.01) * Math.exp(-t / (duration / 3.5))
		write(buses.fx, startIndex + i, high * env * gain * 0.1, 0, 0.6)
	}
}

/** Soft glassy bell for the "stays lit" sparkle and the closing chord. */
function renderBell(note: number, start: number, gain: number, pan: number) {
	const frequency = midiToFrequency(note)
	const startIndex = Math.round(start * sampleRate)
	const length = Math.round(2.6 * sampleRate)
	let carrier = 0
	let modulator = 0
	for (let i = 0; i < length; i++) {
		const t = i / sampleRate
		const env = Math.min(1, t / 0.003) * Math.exp(-t / 0.55)
		const index = 1.2 * Math.exp(-t / 0.25)
		const sample = Math.sin(
			2 * Math.PI * carrier + Math.sin(2 * Math.PI * modulator) * index,
		)
		carrier += frequency / sampleRate
		modulator += (frequency * 3.5) / sampleRate
		write(buses.keys, startIndex + i, sample * env * gain * 0.07, pan, 0.55)
	}
}

// Notes (MIDI). D major.
const chords = {
	bm7: [59, 62, 66, 69],
	gmaj7: [55, 59, 62, 66],
	em7: [52, 55, 59, 62],
	asus: [57, 62, 64, 69],
	dmaj7: [62, 66, 69, 73],
	aadd9: [57, 61, 64, 71],
	bm7Voiced: [59, 62, 66, 69],
	gmaj7Voiced: [55, 62, 66, 71],
	dmaj9: [62, 66, 69, 73, 76],
}

const introBars = [
	{ chord: chords.bm7, bass: 35 },
	{ chord: chords.gmaj7, bass: 31 },
	{ chord: chords.em7, bass: 28 },
	{ chord: chords.gmaj7, bass: 31 },
	{ chord: chords.asus, bass: 33 },
]

const grooveBars = [
	{ chord: chords.dmaj7, bass: 38 },
	{ chord: chords.aadd9, bass: 33 },
	{ chord: chords.bm7Voiced, bass: 35 },
	{ chord: chords.gmaj7Voiced, bass: 31 },
]

// Bars 1–5: the integration tax. Clipped plucks and a ticking hat, pad
// held back under a closed filter so the drop has somewhere to go.
for (const [index, bar] of introBars.entries()) {
	const barNumber = index + 1
	renderPadChord({
		notes: bar.chord,
		start: barTime(barNumber),
		duration: barSeconds,
		gain: 0.55 + index * 0.07,
		cutoffFrom: 500 + index * 150,
		cutoffTo: 750 + index * 220,
		attack: 0.5,
		release: 0.4,
	})
	const pattern = [0, 2, 3, 5, 6]
	for (let eighth = 0; eighth < 8; eighth++) {
		const note =
			bar.chord[pattern[eighth % pattern.length]! % bar.chord.length]!
		renderKey({
			note: note + 12,
			start: barTime(barNumber, eighth / 2),
			decay: 0.11,
			gain: 0.75 + (eighth % 2 === 0 ? 0.15 : 0),
			pan: eighth % 2 === 0 ? -0.35 : 0.35,
			brightness: 0.7,
			send: 0.2,
		})
	}
	for (let sixteenth = 0; sixteenth < 16; sixteenth++) {
		if (barNumber === 5 && sixteenth >= 12) break
		const accent = sixteenth % 4 === 2 ? 1 : 0.45
		renderHat(
			barTime(barNumber, sixteenth / 4),
			accent * (0.5 + index * 0.12),
			false,
			0.25,
		)
	}
	if (barNumber >= 3) {
		renderBassNote({
			note: bar.bass,
			start: barTime(barNumber),
			duration: barSeconds * 0.9,
			gain: 0.55,
		})
	}
	if (barNumber >= 4) {
		for (const beat of barNumber === 5 ? [0, 1.5] : [0, 2]) {
			renderKick(barTime(barNumber, beat), 0.5)
		}
	}
}
renderRiser(barTime(4, 2), barSeconds * 1.5 - 0.12, 1)
for (let sixteenth = 0; sixteenth < 8; sixteenth++) {
	renderClap(barTime(5, 2 + sixteenth / 4), 0.25 + sixteenth * 0.08)
}

// Bars 6–13: connect once, then generate and multiply. Four-on-the-floor, warm pads,
// an eighth-note bass, and an arpeggio that opens up in the second pass.
for (let pass = 0; pass < 2; pass++) {
	for (const [index, bar] of grooveBars.entries()) {
		const barNumber = 6 + pass * 4 + index
		renderPadChord({
			notes: bar.chord,
			start: barTime(barNumber),
			duration: barSeconds,
			gain: pass === 0 ? 0.9 : 1,
			cutoffFrom: pass === 0 ? 1500 : 2200,
			cutoffTo: pass === 0 ? 2200 : 2800,
			attack: 0.04,
			release: 0.25,
		})
		for (let beat = 0; beat < 4; beat++) {
			renderKick(barTime(barNumber, beat), 1)
			if (beat % 2 === 1) renderClap(barTime(barNumber, beat), 0.85)
			renderHat(barTime(barNumber, beat + 0.5), 0.9, true, -0.2)
			renderHat(barTime(barNumber, beat + 0.25), 0.4, false, 0.3)
			renderHat(barTime(barNumber, beat + 0.75), 0.45, false, 0.3)
		}
		const bassPattern = [0, 0, 12, 0, 0, 12, 0, 7]
		for (let eighth = 0; eighth < 8; eighth++) {
			renderBassNote({
				note: bar.bass + bassPattern[eighth]!,
				start: barTime(barNumber, eighth / 2),
				duration: beatSeconds * 0.42,
				gain: eighth % 2 === 0 ? 0.95 : 0.75,
			})
		}
		const arp = [0, 1, 2, 3, 2, 1, 2, 3]
		const steps = pass === 0 ? 8 : 16
		for (let step = 0; step < steps; step++) {
			const note = bar.chord[arp[step % arp.length]! % bar.chord.length]!
			renderKey({
				note: note + 12,
				start: barTime(barNumber, (step * 4) / steps),
				decay: pass === 0 ? 0.32 : 0.22,
				gain: pass === 0 ? 0.75 : 0.6 + (step % 4 === 0 ? 0.2 : 0),
				pan: Math.sin(step * 0.9) * 0.45,
				brightness: pass === 0 ? 0.9 : 1.05,
			})
		}
		if (pass === 1) {
			const sparkle = [74, 78, 81, 83, 81, 78]
			for (let hit = 0; hit < 3; hit++) {
				renderBell(
					sparkle[(index * 2 + hit) % sparkle.length]!,
					barTime(barNumber, hit * 1.5),
					0.9,
					hit % 2 === 0 ? -0.4 : 0.4,
				)
			}
		}
	}
}
renderShimmer(barTime(6), barSeconds * 1.2, 1)
renderShimmer(barTime(10), barSeconds, 0.7)
renderRiser(barTime(13, 2), beatSeconds * 2, 0.55)

// Bar 14 on: the tagline. One open chord that rings out.
renderKick(barTime(14), 1)
renderShimmer(barTime(14), barSeconds * 2, 1)
renderPadChord({
	notes: chords.dmaj9,
	start: barTime(14),
	duration: barSeconds * 1.4,
	gain: 1.05,
	cutoffFrom: 2600,
	cutoffTo: 1200,
	attack: 0.02,
	release: 1.4,
})
renderBassNote({ note: 38, start: barTime(14), duration: 2.4, gain: 0.9 })
for (const [index, note] of [74, 78, 81, 85, 88].entries()) {
	renderBell(
		note,
		barTime(14, index * 0.5),
		1,
		(index % 2 === 0 ? -1 : 1) * 0.35,
	)
}
for (const [index, note] of chords.dmaj9.entries()) {
	renderKey({
		note: note + 12,
		start: barTime(14) + index * 0.03,
		decay: 0.9,
		gain: 0.7,
		pan: (index / 4) * 1.2 - 0.6,
	})
}

function sidechainGain(index: number, depth: number) {
	const t = index / sampleRate
	let gain = 1
	for (let k = kickTimes.length - 1; k >= 0; k--) {
		const since = t - kickTimes[k]!
		if (since < 0) continue
		gain = 1 - depth * Math.exp(-since / 0.11)
		break
	}
	return gain
}

/** Freeverb-style room: parallel combs into series allpasses per side. */
function renderReverb(send: Bus): Bus {
	const out = createBus()
	const combTunings = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
	const allpassTunings = [556, 441, 341, 225]
	const scale = sampleRate / 44_100
	for (const [side, spread] of [
		[send.left, 0],
		[send.right, 23],
	] as const) {
		const target = spread === 0 ? out.left : out.right
		const combs = combTunings.map((tuning) => {
			const size = Math.round((tuning + spread) * scale)
			return { buffer: new Float32Array(size), index: 0, store: 0 }
		})
		const allpasses = allpassTunings.map((tuning) => {
			const size = Math.round((tuning + spread) * scale)
			return { buffer: new Float32Array(size), index: 0 }
		})
		const feedback = 0.86
		const damp = 0.3
		for (let i = 0; i < totalSamples; i++) {
			const input = side[i]! * 0.015
			let sum = 0
			for (const comb of combs) {
				const output = comb.buffer[comb.index]!
				comb.store = output * (1 - damp) + comb.store * damp
				comb.buffer[comb.index] = input + comb.store * feedback
				comb.index = (comb.index + 1) % comb.buffer.length
				sum += output
			}
			for (const allpass of allpasses) {
				const buffered = allpass.buffer[allpass.index]!
				allpass.buffer[allpass.index] = sum + buffered * 0.5
				sum = buffered - sum
				allpass.index = (allpass.index + 1) % allpass.buffer.length
			}
			target[i] = sum
		}
	}
	return out
}

const reverb = renderReverb(buses.reverbSend)
const left = new Float32Array(totalSamples)
const right = new Float32Array(totalSamples)
const fadeOutStart = 26.8
for (let i = 0; i < totalSamples; i++) {
	const duck = sidechainGain(i, 0.55)
	const lightDuck = sidechainGain(i, 0.3)
	const t = i / sampleRate
	const fadeIn = Math.min(1, t / 0.4)
	const fadeOut =
		t < fadeOutStart
			? 1
			: Math.max(
					0,
					1 - (t - fadeOutStart) / (durationSeconds - fadeOutStart),
				) ** 1.6
	const mix = (channel: 'left' | 'right') =>
		buses.pad[channel][i]! * duck +
		buses.keys[channel][i]! * lightDuck +
		buses.bass[channel][i]! * duck +
		buses.drums[channel][i]! +
		buses.fx[channel][i]! +
		reverb[channel][i]! * 0.9
	left[i] = mix('left') * fadeIn * fadeOut
	right[i] = mix('right') * fadeIn * fadeOut
}

// DC and rumble out, then a gentle glue saturation.
for (const channel of [left, right]) {
	let previousInput = 0
	let previousOutput = 0
	const coefficient = Math.exp((-2 * Math.PI * 28) / sampleRate)
	for (let i = 0; i < totalSamples; i++) {
		const input = channel[i]!
		const output = coefficient * (previousOutput + input - previousInput)
		previousInput = input
		previousOutput = output
		channel[i] = Math.tanh(output * 1.25) / 1.25
	}
}

let peak = 0
for (let i = 0; i < totalSamples; i++) {
	peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!))
}
const normalize = 10 ** (-1.5 / 20) / peak

const bytesPerSample = 2
const dataSize = totalSamples * 2 * bytesPerSample
const wav = Buffer.alloc(44 + dataSize)
wav.write('RIFF', 0)
wav.writeUInt32LE(36 + dataSize, 4)
wav.write('WAVE', 8)
wav.write('fmt ', 12)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(2, 22)
wav.writeUInt32LE(sampleRate, 24)
wav.writeUInt32LE(sampleRate * 2 * bytesPerSample, 28)
wav.writeUInt16LE(2 * bytesPerSample, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(dataSize, 40)
for (let i = 0; i < totalSamples; i++) {
	for (const [channelIndex, channel] of [left, right].entries()) {
		const dither = (random() - random()) / 32768
		const value = Math.max(-1, Math.min(1, channel[i]! * normalize + dither))
		wav.writeInt16LE(
			Math.round(value * 32767),
			44 + (i * 2 + channelIndex) * bytesPerSample,
		)
	}
}

mkdirSync(path.dirname(outputPath), { recursive: true })
writeFileSync(outputPath, wav)
console.log(
	`Wrote ${path.relative(process.cwd(), outputPath)} (${durationSeconds}s, peak normalized from ${peak.toFixed(3)})`,
)
