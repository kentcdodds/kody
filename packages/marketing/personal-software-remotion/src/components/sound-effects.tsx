import { Audio } from '@remotion/media'
import { Sequence, staticFile } from 'remotion'
import { arrivals, cues, triggerTicks } from '../choreography.ts'
import { checklist, openingCues, shells } from '../opening-cues.ts'

/**
 * Kenney CC0 one-shots (`public/sfx/`). Tonal ones are in D major like the
 * score: `card-pop` is F#5, `check` is D5, `ping` is B6, so `semitones`
 * offsets keep them in key.
 */
type SfxName =
	| 'card-pop'
	| 'cards-clear'
	| 'check'
	| 'error'
	| 'list-item'
	| 'live'
	| 'ping'
	| 'slam'
	| 'thud'
	| 'window-in'
	| 'window-out'

type Hit = { at: number; name: SfxName; volume: number; semitones?: number }

/** The opening stays about 8 dB under the drop so the lantern lands big. */
const openingLevel = 0.55

/** F# G A B D E: every app pays the same little tune, just faster. */
const cardPhrase = [0, 1, 3, 5, 8, 10]

function openingHits(): Array<Hit> {
	const hits: Array<Hit> = []
	shells.forEach((shell, index) => {
		const small = index >= 2
		hits.push({
			at: shell.enterAt,
			name: 'window-in',
			volume: small ? 0.3 : 0.5,
		})
		if (shell.stacked) {
			hits.push({ at: shell.stacked.at, name: 'window-out', volume: 0.3 })
		}
		shell.cardTimes.forEach((at, card) => {
			const expired = card === 5
			hits.push(
				expired
					? { at, name: 'error', volume: 0.45 }
					: {
							at,
							name: 'card-pop',
							volume: small ? 0.38 : 0.5,
							semitones: cardPhrase[card],
						},
			)
		})
	})
	checklist.forEach((item, index) => {
		hits.push({
			at: openingCues.checklist + index * 4,
			name: 'list-item',
			volume: 0.2,
		})
		hits.push({
			at: item.done,
			name: 'check',
			volume: 0.5,
			semitones: [0, 4, 7][index],
		})
	})
	hits.push({ at: openingCues.build.start, name: 'cards-clear', volume: 0.4 })
	hits.push({ at: openingCues.deploy.live, name: 'live', volume: 0.45 })
	openingCues.andAgain.forEach((at, index) => {
		hits.push({ at, name: 'thud', volume: 0.6, semitones: index * -2 })
	})
	hits.push({ at: openingCues.ugh, name: 'slam', volume: 0.85 })
	return hits.map((hit) => ({ ...hit, volume: hit.volume * openingLevel }))
}

const arrivalNotes = [-5, -2, 0, 3, 5]
const triggerNotes = [-2, 0, 3]

function laterHits(): Array<Hit> {
	return [
		...arrivals.map((arrival, index) => ({
			at: arrival.at,
			name: 'ping' as const,
			volume: 0.22,
			semitones: arrivalNotes[index],
		})),
		{ at: cues.appBuild - 2, name: 'window-in', volume: 0.3 },
		...triggerTicks.map((at, index) => ({
			at,
			name: 'ping' as const,
			volume: 0.2,
			semitones: triggerNotes[index],
		})),
	]
}

const hits = [...openingHits(), ...laterHits()]

export function SoundEffects() {
	return hits.map((hit, index) => (
		<Sequence
			key={index}
			from={hit.at}
			layout="none"
			name={`sfx · ${hit.name}`}
		>
			<Audio
				src={staticFile(`sfx/${hit.name}.wav`)}
				volume={hit.volume}
				toneFrequency={2 ** ((hit.semitones ?? 0) / 12)}
			/>
		</Sequence>
	))
}
