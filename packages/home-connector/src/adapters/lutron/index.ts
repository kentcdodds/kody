import { type HomeConnectorConfig } from '../../config.ts'
import { type HomeConnectorState } from '../../state.ts'
import { type HomeConnectorStorage } from '../../storage/index.ts'
import {
	listMockLutronAreas,
	listMockLutronButtonsForDevice,
	listMockLutronControlStations,
	listMockLutronVirtualButtons,
	listMockLutronZones,
	pressMockLutronButton,
	setMockLutronZoneLevel,
	validateMockLutronCredentials,
} from './mock-driver.ts'
import { scanLutronProcessors } from './discovery.ts'
import {
	authenticateLutronProcessor,
	loadLutronInventory,
	pressLutronButton,
	setLutronShadeLevel,
	setLutronZoneColor,
	setLutronZoneLevel,
	setLutronZoneSwitchedLevel,
	setLutronZoneWhiteTuning,
} from './leap-client.ts'
import {
	listLutronProcessors,
	requireLutronProcessor,
	saveLutronCredentials,
	updateLutronAuthStatus,
	upsertDiscoveredLutronProcessors,
} from './repository.ts'
import { type LutronInventory, type LutronSceneButton } from './types.ts'

function isMockLutronHost(host: string) {
	return host.endsWith('.mock.local')
}

function requireLutronCredentials(processor: {
	processorId: string
	username: string | null
	password: string | null
}) {
	if (!processor.username || !processor.password) {
		throw new Error(
			`Lutron processor "${processor.processorId}" is missing stored credentials. Run lutron_set_credentials first.`,
		)
	}
	return {
		username: processor.username,
		password: processor.password,
	}
}

export function createLutronAdapter(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	storage: HomeConnectorStorage
}) {
	function listProcessors() {
		return listLutronProcessors(input.storage, input.config.homeConnectorId)
	}

	function buildMockInventory(processorId: string) {
		const processor = requireLutronProcessor(
			input.storage,
			input.config.homeConnectorId,
			processorId,
		)
		const areas = listMockLutronAreas(processorId)
		const zones = areas.flatMap((area) =>
			listMockLutronZones(processorId, area.areaId),
		)
		const controlStations = areas.flatMap((area) =>
			listMockLutronControlStations(processorId, area.areaId),
		)
		const buttons = controlStations.flatMap((station) =>
			station.devices.flatMap((device) =>
				listMockLutronButtonsForDevice(device.deviceId),
			),
		)
		const virtualButtons = listMockLutronVirtualButtons(processorId)
		const sceneButtons: Array<LutronSceneButton> = [
			...buttons.map((button) => ({ kind: 'keypad' as const, ...button })),
			...virtualButtons
				.filter((button) => button.isProgrammed)
				.map((button) => ({ kind: 'virtual' as const, ...button })),
		]
		return {
			processor,
			areas,
			zones,
			controlStations,
			buttons,
			virtualButtons,
			sceneButtons,
		} satisfies LutronInventory
	}

	return {
		async scan() {
			const result = await scanLutronProcessors(input.state, input.config)
			return upsertDiscoveredLutronProcessors(
				input.storage,
				input.config.homeConnectorId,
				result.processors,
			)
		},
		getStatus() {
			const processors = listProcessors()
			return {
				processors,
				diagnostics: input.state.lutronDiscoveryDiagnostics,
				configuredCredentialsCount: processors.filter(
					(processor) => processor.username && processor.password,
				).length,
			}
		},
		setCredentials(processorId: string, username: string, password: string) {
			requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			saveLutronCredentials({
				storage: input.storage,
				connectorId: input.config.homeConnectorId,
				processorId,
				username,
				password,
			})
			return requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
		},
		async authenticate(processorId: string) {
			const processor = requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			try {
				if (input.config.mocksEnabled && isMockLutronHost(processor.host)) {
					if (
						!validateMockLutronCredentials(
							processor.host,
							credentials.username,
							credentials.password,
						)
					) {
						throw new Error(
							'Lutron mock authorization failed because the credentials are invalid.',
						)
					}
				} else {
					await authenticateLutronProcessor({
						processor,
						credentials,
					})
				}
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
			} catch (error) {
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: null,
					lastAuthError: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
			return requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
		},
		async getInventory(processorId: string) {
			const processor = requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			try {
				const inventory =
					input.config.mocksEnabled && isMockLutronHost(processor.host)
						? buildMockInventory(processorId)
						: await loadLutronInventory({
								processor,
								credentials,
							})
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return inventory
			} catch (error) {
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: null,
					lastAuthError: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
		},
		async pressButton(processorId: string, buttonId: string) {
			const processor = requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			try {
				const response =
					input.config.mocksEnabled && isMockLutronHost(processor.host)
						? pressMockLutronButton(buttonId)
						: await pressLutronButton({
								processor,
								credentials,
								buttonId,
							})
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return {
					ok: true,
					processorId,
					buttonId,
					response,
				}
			} catch (error) {
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: null,
					lastAuthError: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
		},
		async setZoneLevel(processorId: string, zoneId: string, level: number) {
			const processor = requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			try {
				const response =
					input.config.mocksEnabled && isMockLutronHost(processor.host)
						? setMockLutronZoneLevel(zoneId, level)
						: await setLutronZoneLevel({
								processor,
								credentials,
								zoneId,
								level,
							})
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return {
					ok: true,
					processorId,
					zoneId,
					level,
					response,
				}
			} catch (error) {
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: null,
					lastAuthError: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
		},
		async setZoneColor(
			processorId: string,
			zoneId: string,
			inputColor: {
				hue: number
				saturation: number
				level?: number
				vibrancy?: number
			},
		) {
			const processor = requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			try {
				const response = await setLutronZoneColor({
					processor,
					credentials,
					zoneId,
					hue: inputColor.hue,
					saturation: inputColor.saturation,
					level: inputColor.level,
					vibrancy: inputColor.vibrancy,
				})
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return {
					ok: true,
					processorId,
					zoneId,
					hue: inputColor.hue,
					saturation: inputColor.saturation,
					level: inputColor.level ?? null,
					vibrancy: inputColor.vibrancy ?? null,
					response,
				}
			} catch (error) {
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: null,
					lastAuthError: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
		},
		async setZoneWhiteTuning(
			processorId: string,
			zoneId: string,
			inputWhiteTuning: {
				kelvin: number
				level?: number
			},
		) {
			const processor = requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			try {
				const response = await setLutronZoneWhiteTuning({
					processor,
					credentials,
					zoneId,
					kelvin: inputWhiteTuning.kelvin,
					level: inputWhiteTuning.level,
				})
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return {
					ok: true,
					processorId,
					zoneId,
					kelvin: inputWhiteTuning.kelvin,
					level: inputWhiteTuning.level ?? null,
					response,
				}
			} catch (error) {
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: null,
					lastAuthError: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
		},
		async setZoneSwitchedLevel(
			processorId: string,
			zoneId: string,
			state: 'On' | 'Off',
		) {
			const processor = requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			try {
				const response = await setLutronZoneSwitchedLevel({
					processor,
					credentials,
					zoneId,
					state,
				})
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return {
					ok: true,
					processorId,
					zoneId,
					state,
					response,
				}
			} catch (error) {
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: null,
					lastAuthError: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
		},
		async setShadeLevel(processorId: string, zoneId: string, level: number) {
			const processor = requireLutronProcessor(
				input.storage,
				input.config.homeConnectorId,
				processorId,
			)
			const credentials = requireLutronCredentials(processor)
			try {
				const response = await setLutronShadeLevel({
					processor,
					credentials,
					zoneId,
					level,
				})
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: new Date().toISOString(),
					lastAuthError: null,
				})
				return {
					ok: true,
					processorId,
					zoneId,
					level,
					response,
				}
			} catch (error) {
				updateLutronAuthStatus({
					storage: input.storage,
					connectorId: input.config.homeConnectorId,
					processorId,
					lastAuthenticatedAt: null,
					lastAuthError: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
		},
	}
}
