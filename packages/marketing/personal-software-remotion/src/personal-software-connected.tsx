import { Audio } from '@remotion/media'
import { type ReactNode } from 'react'
import { AbsoluteFill, Sequence, staticFile } from 'remotion'
import {
	AppWorld,
	AppWorldBeams,
	HeadlineScrim,
	TriggerFlashes,
} from './components/app-world.tsx'
import { Backdrop } from './components/backdrop.tsx'
import { Lantern } from './components/lantern.tsx'
import { SoundEffects } from './components/sound-effects.tsx'
import { ArrivalsOverlay, ConnectOnce } from './scenes/connect-once.tsx'
import { GenerateApp, PromptBar } from './scenes/generate-app.tsx'
import { IntegrationTax } from './scenes/integration-tax.tsx'
import { StaysLit } from './scenes/stays-lit.tsx'
import { Tagline, TaglineRing } from './scenes/tagline.tsx'
import { scenes } from './timing.ts'

type SceneId = keyof typeof scenes

function Scene({
	id,
	name,
	children,
}: {
	id: SceneId
	name: string
	children: ReactNode
}) {
	const scene = scenes[id]
	return (
		<Sequence
			from={scene.from}
			durationInFrames={scene.until - scene.from}
			name={name}
		>
			{children}
		</Sequence>
	)
}

/**
 * Layer order matters: beams sit under the app world so tiles cover their
 * ends, and the world sits under the lantern so the hub glows over it.
 * Flying marks and the front of the closing ring sit over the lantern.
 * Scene components add their `from` back to read global cue frames.
 */
export function PersonalSoftwareConnected() {
	return (
		<AbsoluteFill style={{ backgroundColor: 'black' }}>
			<Backdrop />
			<Scene id="integrationTax" name="Beat 1 · integration tax">
				<IntegrationTax />
			</Scene>
			<Scene id="connectOnce" name="Beat 2 · connect once">
				<ConnectOnce />
			</Scene>
			<Scene id="appWorld" name="Beats 3–4 · beams">
				<AppWorldBeams />
			</Scene>
			<Scene id="appWorld" name="Beats 3–4 · apps">
				<AppWorld />
			</Scene>
			<Scene id="appWorld" name="Beat 4 · trigger flashes">
				<TriggerFlashes />
			</Scene>
			<Scene id="appWorld" name="Beats 3–4 · headline scrim">
				<HeadlineScrim />
			</Scene>
			<Scene id="generateApp" name="Beat 3 · headline">
				<GenerateApp />
			</Scene>
			<Scene id="staysLit" name="Beat 4 · stays lit">
				<StaysLit />
			</Scene>
			<Scene id="generateApp" name="Beat 3 · prompt">
				<PromptBar />
			</Scene>
			<Scene id="tagline" name="Close · ring (back)">
				<TaglineRing layer="back" />
			</Scene>
			<Lantern />
			<Scene id="connectOnce" name="Beat 2 · arrivals">
				<ArrivalsOverlay />
			</Scene>
			<Scene id="tagline" name="Close · ring (front)">
				<TaglineRing layer="front" />
			</Scene>
			<Scene id="tagline" name="Close · tagline">
				<Tagline />
			</Scene>
			<Audio src={staticFile('music/personal-software-soundtrack.m4a')} />
			<SoundEffects />
		</AbsoluteFill>
	)
}
