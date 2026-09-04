# Changelog

All notable changes to this project are documented in this file.

## [4.1.1] - 2026-09-04

### Fixed

- **A dropped connection no longer loses the command outright.** Only HTTP 423 was retried, so a
  bare `fetch failed` — which is what a gen1 hub gives you when it drops a TCP connection while
  its radio is transmitting — threw immediately and the shade never moved. Transient network
  failures now retry three times, 500ms apart.

### Changed

- **`requestIntervalMs` returns to a 100ms default**, reverting the 25ms introduced in 4.1.0. The
  probe behind that number ran cached reads, which never engage the hub's radio; writes do. In
  practice a five-shade group move at 25ms lost two shades to dropped connections. The option
  stays, so the spacing can still be retuned — against writes, not just reads.

## [4.1.0] - 2026-09-04

### Added

- `requestIntervalMs` (default `25`), exposed in the Homebridge UI schema. Spacing between
  serialised hub requests, so a hub that struggles under load can be given more room without a
  code change.

### Changed

- **HomeKit writes now overtake background reads.** The request queue was strictly FIFO, so a
  shade command issued while a refresh was in flight waited for that refresh and for every read
  queued ahead of it. Writes now run first, FIFO within a priority, still one request at a time
  because the hub cannot do better.
- **Request spacing drops from 100ms to 25ms.** Measured, not guessed: 30 serialised reads
  against a gen1 hub on build 827 at 100/50/25/10/0ms spacing returned 30/30 valid responses in
  every condition — no bad status, no malformed JSON, no timeouts — with response times flat at
  ~70ms. 25ms keeps headroom rather than removing the guard.
- The spacing delay no longer runs after the final request, only between requests.

### Notes

- This takes roughly 375ms off a five-shade group move, but does not make shades move in unison.
  Five sequential round-trips are ~350ms of irreducible spread. Only a hub scene, which is one
  call the hub expands itself, can move a group together — scene support is not implemented yet.

## [4.0.0] - 2026-09-04

First release under the name **homebridge-powerview-universal**. Consolidates the
`3.1.4-local.1` … `3.1.4-local.8` working versions, none of which were published.
All hub behaviour below was verified against a PowerView hub on firmware build 827.

Major rather than minor: the npm package is renamed, so this does not upgrade in
place — the old package must be uninstalled and this one installed. `PLUGIN_NAME`
changes with it, which migrates the cached accessories. Battery polling also
changes from on-by-default to off-by-default.

### Added

- `batteryPolling` (boolean, default `false`) and `batteryPollAt` (`"HH:MM"`, default `14:00`)
  config options, both exposed in the Homebridge UI schema.
- `syncPositionsOnStart` (boolean, default `true`) and `quietHours` (default 21:00–08:00).
  Homebridge can restart unattended, so the startup position sync is skipped inside the quiet
  window rather than being free to wake every motor at 03:00.
- `PowerViewHub.stopShade()`; `jogShade` and `stopShade` now share one `motionRequest` path.
- An ISC `LICENSE` file, naming the full copyright chain from 2018 onward.

### Changed

- **Battery polling is now opt-in and off by default.** It previously ran every 6 hours on a
  timer anchored to plugin start, with no config option. `updateBatteryLevel=true` is an RF
  round-trip that wakes the shade motor — 3.73s against 0.08s for a cached read, audible, and it
  nudges the shade. On a 6-hour period at least one poll always landed overnight regardless of
  restart time; observed waking a household at 05:54 (5 shades). The hub already refreshes
  battery weekly on its own, which is what makes off-by-default correct rather than merely quiet.
- Polling, when enabled, runs **once per day at a configurable local time** instead of on an
  interval. The next deadline is recomputed from the current time after every run, so the poll
  stays pinned to the same wall-clock time across DST changes. Runs are logged at `info`; the old
  poll logged nothing on success, which is why the shade movement could not be attributed.
- **Shade behaviour is resolved from ShadeCapabilities, not from a hand-picked type list.** The
  old `SHADE_TYPE_IDS` knew 6 shade types; the PowerView Hub REST API v2 appendix
  (jlaur/hdpowerview-doc v1.0.4) documents **26**, mapped onto 10 capability classes. That left
  20 types falling through to "unknown type, assuming roller", and for 17 of them roller is
  wrong. Capability now comes from the hub's own `capabilities` field when it reports one, and
  from the documented type table otherwise — older hubs, including build 827, omit the field.
- **Unsupported capabilities are stated rather than silently mistreated.** Capability 6 runs its
  primary rail *reversed*, 2 and 5 tilt through 180 degrees rather than the 90 the tilt maths
  assumes, and 8/9 have overlapped panels. These are still driven as rollers, but now warn once
  per shade that position or tilt may be wrong instead of reporting a confident wrong number.
  Implementing their maths needs hardware to verify against, so it is not guessed at here.
- **Every hub request is serialised through one promise chain** with `REQUEST_INTERVAL_MS`
  spacing. Legacy hubs answer one request at a time, but only shade requests went through the
  existing queue — capability probes and `/api/shades` called `fetchJson` directly and raced it,
  which made the hub time out and return truncated JSON mid-response.
- **HomeKit position reads answer from cache immediately** and refresh in the background, deduped
  per shade. The old blocking refresh inside the read handler routinely exceeded HomeKit's read
  budget and logged "read handler didn't respond at all". `strictErrors` keeps the old blocking
  behaviour, since that option exists to surface hub failures.
- Positions are logged only when they change, and the message says what it is. `Set for <id>`
  fired at `info` on every read — four identical lines in twelve seconds during one restart — and
  read like a write when it was a read.
- Errors preserve the underlying failure as `cause`, and timeouts are distinguished from
  unreachable hosts instead of every failure reporting as Unreachable.
- `PositionMap` is defined once in `shadeUtils.ts` instead of being redeclared in `platform.ts`.
- **A poll costs half the hub requests it did.** `/api/shades` already returns each shade, but the
  loop then called `getShade(id)` for every one, so N shades meant 2N serialised requests per
  cycle. The per-shade fetch now runs only when the list entry carried no positions.
- Package renamed to `homebridge-powerview-universal`; repository, bugs, and homepage links now
  point at this fork rather than upstream's tracker.

### Fixed

- **Hub requests still overlapped after being serialised.** `serialize()` wrapped only the
  `fetch()` call, and `fetch()` settles when response headers arrive, not when the body is
  consumed — so `response.json()` ran after the chain had already advanced, streaming one
  request's body while the next request was already in flight. That is the overlap that makes a
  legacy hub time out and return truncated JSON. The body is now read inside the serialised
  section.
- **A tilt report no longer forces the shade to read as fully closed.** Both vanes branches
  called `applyCoveringPosition(service, 0)`, so `posKind1` set the real position and `posKind2`
  immediately overwrote it with 0 in the same loop. Every tilt-capable shade reported itself
  closed while the cache held the true value.
- **Restarts no longer report a shade as fully closed.** `configure()` seeded `CurrentPosition`
  to 0 unconditionally, running on every restart immediately after the cache was restored — so
  the persisted position was overwritten before HomeKit could read it. It now seeds from the
  cache for both rails.
- **The shade poll no longer survives shutdown.** Its `setTimeout` handle was never stored, so
  the shutdown listener could not clear it; with `pollShadesForUpdate` enabled, shutdown left a
  30s loop hitting the hub and holding the event loop open.
- **A position set for a removed shade reports an error instead of crashing.** `setPosition` read
  `this.accessories[shadeId].context` unguarded, before its `try`, so the throw escaped the
  HomeKit handler as an unhandled rejection.
- **Every reported position kind is read.** The loop terminated at the first absent `posKind` and
  silently dropped every kind after a gap.
- **An unusable position value is skipped rather than cached as `NaN`.** HAP rejected the
  characteristic write, but the `NaN` still reached the position map, where it defeats
  `positionMapsEqual` — `NaN !== NaN` — so every subsequent read rewrote the accessory cache file.
- **Requests could hang forever.** Node's `fetch` has no default timeout and the hub serialises
  every call through one queue, so a half-open socket stalled all later requests indefinitely.
  Every hub request now carries a 15s `AbortController` timeout.
- **A throw during shade URL construction wedged the queue**, leaving pending HomeKit requests
  unresolved. The URL is built inside the `try` and the queue advances in a `finally`.
- **Battery percentage was wrong above 100.** `batteryStrength` is tenths of a volt against an
  18.0V nominal pack (matching aiopvapi), not a 0–100 percentage. Any Gen 1/2 reading above 100
  fell through to a four-value `batteryStatus` lookup, so a pack at 67% and one at 98% both
  reported 90%.
- **`batteryStrength` 0 is treated as unknown rather than empty.** The hub reports 0 for shades it
  has not polled, which raised a false low-battery warning.
- **`StatusLowBattery` is no longer set on `AccessoryInformation`**, where it is not a valid
  characteristic and logged a warning per shade per refresh.
- **Hub generation is derived from the firmware revision.** Both Gen 1 and Gen 2 report
  `mainProcessor.name` as "PowerView Hub", so the name never matched.
- **`Invalid position value received` no longer fires on the happy path.** This hub returns no
  `positions` object at all on a cached read — positions exist only after a `refresh=true` read or
  a set — so the key was absent on *every* HomeKit position read and the warning fired 77 times in
  one day. Absent is now `debug` plus a once-per-shade `info`; only a key present with unusable
  data still warns, and the message includes the value.
- **Last known positions persist across restarts**, written to accessory context via
  `api.updatePlatformAccessories()` and restored (validated) in `configureAccessory`. A cold cache
  no longer falls through to `resolvePositionValue()`'s `0`, which reads as "fully closed" in the
  Home app until the background refresh lands, and sticks if that refresh times out. Writes are
  guarded by `positionMapsEqual` so an ordinary read that changes nothing does not rewrite the
  cache file.
- **Positions are re-synced once at startup** for shades the hub has no position for. Persisting
  the cache meant `value == null` was never true, so `scheduleBackgroundRefresh` never fired and a
  stale position could be served indefinitely.
- **HoldPosition jogged the shade instead of stopping it.** HomeKit's `HoldPosition` was wired to
  `jogShade`, so asking a shade to stop made it wiggle. It now sends `motion: "stop"`, and is no
  longer gated on `jogSupported`, which was the wrong capability.
- **`PLUGIN_NAME` now matches the package name.** It still read `homebridge-powerview-3` after the
  rename, so Homebridge could not resolve the plugin when registering accessories and logged a
  warning for every shade.
- `probeEndpoint` is given an absolute URL so it cannot throw if it is ever used.

### Removed

- `SHADE_TYPE_IDS`. It listed type 16, which appears nowhere in the published table, and omitted
  the actual vertical shades (54, 55, 56).

### Notes

- Disabling the battery poll does not remove battery reporting: `batteryStrength` /
  `batteryStatus` ride along on ordinary hub reads and still update the HomeKit Battery service.
  The poll only forces a fresh measurement from the shade.
- On first start under the new package name, Homebridge re-associates cached accessories from
  `homebridge-powerview-3` to `homebridge-powerview-universal` automatically and logs that it did
  so. Uninstall the old package first — if both are installed, both claim the `PowerView` platform
  name and cached accessories are dropped instead.

## [3.1.2] - 2026-05-18

### Added

- [RELEASE_NOTES.md](RELEASE_NOTES.md) for publish/GitHub release copy (see Latest section when tagging)

## [3.1.1] - 2026-05-18

### Added

- Linked HomeKit **Battery** service per shade with `BatteryLevel` (0–100%) so battery appears in the Home app, not only the low-battery flag on Accessory Information

## [3.1.0] - 2026-05-18

### Added

- Structured hub HTTP handling with retry on HTTP 423 (hub busy / maintenance)
- Startup capability probe for `/api/fwversion`, `/api/scenes`, and `/api/scenecollections` (logged; scenes not exposed in HomeKit yet)
- Position cache: refresh timeouts and transient read failures return last known values (unless `strictErrors` is enabled)
- `strictErrors` platform option for fail-fast HomeKit reads (debugging)
- Per-shade `FirmwareRevision` and `StatusLowBattery` in Accessory Information when the hub reports them
- Periodic battery refresh via `updateBatteryLevel` (every 6 hours)
- Top/bottom shade top-rail display name from hub `secondaryName`
- **Hold** (Hold Position) and **Identify** wired to hub jog motion where supported
- Vitest unit tests for HTTP classification, position parsing, and battery helpers

### Changed

- `putShade` queue merge skips invalid position kind 4 (hub position error) from PUT bodies
- Shade list failures during poll no longer remove existing accessories

## [3.0.0] - 2026-05-17

### Added

- Homebridge **2.x** support (ESM plugin, Node.js 22/24)
- TypeScript source, `config.schema.json` for Homebridge UI settings
- `AccessoryInformation` service on each shade (manufacturer, hub firmware model)

### Changed

- **Breaking:** npm package renamed to `homebridge-powerview-3`
- **Breaking:** plugin identifier for accessory cache is now `homebridge-powerview-3` (was `homebridge-powerview`)
- Replaced deprecated `request` with native `fetch`
- Replaced `getServiceByUUIDAndSubType` with `getServiceById` (Homebridge 2 API)
- Removed use of removed `accessory.reachable` property
- Modern `api.registerPlatform(PLATFORM_NAME, PowerViewPlatform)` registration
- Hub HTTP client uses Promises/async throughout

### Fixed

- `putShade` queue merge incorrectly deleted bottom position (`delete position[...]` → `delete positions[...]`)
- `jogShade` callback referenced undefined `position` variable
- `removeService` called when top Window Covering service did not exist

### Migration from homebridge-powerview-2

1. Uninstall `homebridge-powerview-2`, install `homebridge-powerview-3`.
2. Keep `"platform": "PowerView"` in `config.json`; add `"name": "PowerView"` if using the config UI schema.
3. Restart Homebridge. Remove duplicate shade accessories from the Home app if the cache identifier change left orphans.

Requires Homebridge **^1.8.0 || ^2.0.0** and Node **^22.12.0 || ^24.0.0**.

## [1.0.9] and earlier

See [homebridge-powerview-2](https://github.com/owenselles/homebridge-powerview-2) history.
