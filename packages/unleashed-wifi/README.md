# @kentcdodds/unleashed-wifi

High-level helpers for the Access Networks / RUCKUS Unleashed AJAX API.

This package wraps the home connector's generic
`home_access_networks_unleashed_request` capability with ergonomic,
single-purpose functions for each common Unleashed operation. Every helper
imports `codemode` from `kody:runtime`, builds the appropriate XML body, and
calls the raw request capability with the high-risk acknowledgement, an operator
reason, and the exact confirmation phrase the home connector expects.

## Setup before calling any helper

The helpers assume the home connector already has an adopted Unleashed
controller with stored credentials. From an MCP client:

1. `home_access_networks_unleashed_scan_controllers`
2. `home_access_networks_unleashed_adopt_controller` with the `controllerId`
3. `home_access_networks_unleashed_set_credentials` with the `username` and
   `password`
4. `home_access_networks_unleashed_authenticate_controller` to confirm the
   stored credentials work

## Usage

```ts
import {
	listAccessPoints,
	listClients,
	disableWlan,
} from 'kody:@kentcdodds/unleashed-wifi'

const aps = await listAccessPoints()
const clients = await listClients()

await disableWlan({
	name: 'Guest',
	reason: 'Maintenance window: taking the guest SSID offline for 30 minutes.',
})
```

Every helper accepts an optional `reason` string (at least 20 characters); a
sensible operator-friendly default is supplied if the caller does not pass one.
Each invocation forwards `acknowledgeHighRisk: true` and the home connector's
required confirmation phrase, so the underlying mutation contract is satisfied
without burdening callers with repetitive boilerplate.

## Exports

### Read operations (`action: 'getstat'`)

- `getStatus`
- `listAccessPoints`
- `listClients`
- `listInactiveClients`
- `listWlans`
- `listWlanGroups`
- `listApGroups`
- `listEvents` (optional `limit`, default 100)
- `listAlarms` (optional `limit`, default 50)
- `listBlockedClients`
- `listDpsks`
- `getMeshInfo`
- `getSyslog`
- `getVapStats`
- `getWlanGroupStats`
- `getApGroupStats`
- `listActiveRogues`
- `listKnownRogues`
- `listBlockedRogues`

### Mutation operations (`action: 'setconf'` or `'docmd'`)

- `blockClient({ mac })`
- `unblockClient({ mac })`
- `disableWlan({ name })`
- `enableWlan({ name })`
- `setWlanPassword({ name, passphrase, saePassphrase? })`
- `addWlan({ ssid, passphrase, options? })`
- `editWlan({ name, changes })`
- `cloneWlan({ sourceName, newName, newSsid? })`
- `deleteWlan({ name })`
- `addWlanGroup({ name, description?, wlanNames? })`
- `cloneWlanGroup({ sourceName, newName, description? })`
- `deleteWlanGroup({ name })`
- `restartAccessPoint({ mac })`
- `hideApLeds({ mac })`
- `showApLeds({ mac })`
- `updateAp({ mac, changes })`
- `upgradeApFirmware({ mac })`
- `markRogueKnown({ mac })`
- `markRogueBlocked({ mac })`
- `unmarkRogue({ mac })`
- `addDpsk({ wlanName, passphrase, options? })`
- `deleteDpsk({ id })`
- `acknowledgeAlarm({ id })`
- `clearAllAlarms()`
- `rebootController()`

## XML payload reference

The XML envelopes used by the helpers follow the patterns in the
[`aioruckus`](https://github.com/ms264556/aioruckus) Python library, adapted to
the home connector's `action: 'getstat' | 'setconf' | 'docmd'` envelope. The
home connector posts to `POST {host}/admin/_cmdstat.jsp` with
`Content-Type: application/x-www-form-urlencoded` and a body of
`request=<ajax-request action="..." comp="..." updater="...">{xmlBody}</ajax-request>`.

## Testing

Unit tests under `src/index.node.test.ts` swap `kody:runtime` for the stub at
`test-support/kody-runtime-stub.ts` (registered as a vitest alias in
`vitest-shared.ts`). The stub records every issued request and lets tests queue
canned XML responses so each helper can be exercised without touching a live
controller.
