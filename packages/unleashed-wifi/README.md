# @kentcdodds/unleashed-wifi

High-level helpers for the Access Networks / RUCKUS Unleashed AJAX API.

This package wraps the home connector's generic
`home_access_networks_unleashed_request` capability with ergonomic,
single-purpose functions for each common Unleashed operation. Every helper
imports `codemode` from `kody:runtime`, builds the appropriate XML body, and
calls the raw request capability with the high-risk acknowledgement, an
operator-facing reason, and the exact confirmation phrase the home connector
expects.

## Setup before calling any helper

The helpers assume the home connector already has an adopted Unleashed
controller with stored credentials. From an MCP client:

1. `home_access_networks_unleashed_scan_controllers`
2. `home_access_networks_unleashed_adopt_controller` with the `controllerId`
3. `home_access_networks_unleashed_set_credentials` with the `username` and
   `password`
4. `home_access_networks_unleashed_authenticate_controller` to confirm
   credentials

## Usage

```ts
import unleashedWifi from 'kody:@kentcdodds/unleashed-wifi'

const wifi = unleashedWifi()

const aps = await wifi.listAccessPoints()
const clients = await wifi.listClients()

await wifi.disableWlan({
	name: 'Guest',
	reason: 'Maintenance window: taking the guest SSID offline for 30 minutes.',
})
```

Kody only surfaces a saved package's `default` export to consumers, so the
default export is a function that returns the full namespace object containing
every helper.

Every helper accepts an optional `reason` string (at least 20 characters); a
sensible operator-friendly default is supplied if the caller does not pass one.
Each invocation forwards `acknowledgeHighRisk: true` and the home connector's
required confirmation phrase, so the underlying mutation contract is satisfied
without repetitive boilerplate.

## Exports

### Read operations (`action: 'getstat'`)

`getStatus`, `listAccessPoints`, `listClients`, `listInactiveClients`,
`listWlans`, `listWlanGroups`, `listApGroups`, `listEvents` (optional `limit`,
default 100), `listAlarms` (optional `limit`, default 50), `listBlockedClients`,
`listDpsks`, `getMeshInfo`, `getSyslog`, `getVapStats`, `getWlanGroupStats`,
`getApGroupStats`, `listActiveRogues`, `listKnownRogues`, `listBlockedRogues`.

### Mutation operations (`action: 'setconf'` or `'docmd'`)

`blockClient({ mac })`, `unblockClient({ mac })`, `disableWlan({ name })`,
`enableWlan({ name })`, `setWlanPassword({ name, passphrase, saePassphrase? })`,
`addWlan({ ssid, passphrase, options? })`, `editWlan({ name, changes })`,
`cloneWlan({ sourceName, newName, newSsid? })`, `deleteWlan({ name })`,
`addWlanGroup({ name, description?, wlanNames? })`,
`cloneWlanGroup({ sourceName, newName, description? })`,
`deleteWlanGroup({ name })`, `restartAccessPoint({ mac })`,
`hideApLeds({ mac })`, `showApLeds({ mac })`, `updateAp({ mac, changes })`,
`upgradeApFirmware({ mac })`, `markRogueKnown({ mac })`,
`markRogueBlocked({ mac })`, `unmarkRogue({ mac })`,
`addDpsk({ wlanName, passphrase, options? })`, `deleteDpsk({ id })`,
`acknowledgeAlarm({ id })`, `clearAllAlarms()`, `rebootController()`.

## XML payload reference

The XML envelopes follow the patterns in the
[`aioruckus`](https://github.com/ms264556/aioruckus) Python library, adapted to
the home connector's `action: 'getstat' | 'setconf' | 'docmd'` envelope. The
home connector posts each request to `POST {host}/admin/_cmdstat.jsp` with
`Content-Type: text/xml`.

### Rogue management

Rogue list reads use the same `<rogue>` element as `aioruckus`, filtered by the
`recognized`/`blocked` attributes:

| Helper              | XML body                                |
| ------------------- | --------------------------------------- |
| `listActiveRogues`  | `<rogue LEVEL='1' recognized='!true'/>` |
| `listKnownRogues`   | `<rogue LEVEL='1' recognized='true'/>`  |
| `listBlockedRogues` | `<rogue LEVEL='1' blocked='true'/>`     |

Rogue mutations write the matching attributes back through
`action: 'setconf'`/`comp: 'stamgr'`:

| Helper             | XML body                                                |
| ------------------ | ------------------------------------------------------- |
| `markRogueKnown`   | `<rogue mac='...' recognized='true'/>`                  |
| `markRogueBlocked` | `<rogue mac='...' blocked='true'/>`                     |
| `unmarkRogue`      | `<rogue mac='...' recognized='false' blocked='false'/>` |
