# Changelog

All notable changes to this project are documented in this file.

## [3.1.4-local.8] - 2026-09-03

### Changed

- **Shade behaviour is resolved from ShadeCapabilities, not from a hand-picked type list.** The
  old `SHADE_TYPE_IDS` knew 6 shade types; the PowerView appendix documents **26**, mapped onto
  10 capability classes. That left 20 types falling through to "unknown type, assuming roller",
  and for 17 of them the roller assumption is wrong. Capability now comes from the hub's own
  `capabilities` field when it reports one, falling back to the documented type table.
  `SHADE_TYPE_IDS` is removed; it also listed type 16, which appears nowhere in the published
  table.
- **Unsupported capabilities are now stated rather than silently mistreated.** Capability 6 runs
  its primary rail *reversed*, 2 and 5 tilt through 180 degrees rather than 90, and 8/9 have
  overlapped panels. The plugin still drives these as rollers, but warns once per shade that the
  position or tilt may be wrong instead of reporting a confident wrong number.
- Positions are logged only when they change, and the message says what it is. `Set for <id>`
  fired at info on every read — four identical lines in twelve seconds during one restart — and
  read like a write when it was a read.

## [3.1.4-local.7] - 2026-09-03

### Fixed

- **HoldPosition jogged the shade instead of stopping it.** HomeKit's `HoldPosition` was wired to
  `jogShade`, so asking a shade to stop made it wiggle. It now sends `motion: "stop"`, and is no
  longer gated on `jogSupported`, which was the wrong capability.
- **Positions are re-synced once at startup**, restoring what `local.5` removed. Persisting the
  cache meant `value == null` was never true, so `scheduleBackgroundRefresh` never fired and a
  stale position could be served indefinitely. The sync only refreshes shades the hub has no
  position for, so it costs nothing when the hub is already current.

### Added

- `syncPositionsOnStart` (boolean, default `true`) and `quietHours` (default 21:00-08:00).
  Homebridge can restart unattended, so the startup sync is skipped inside the quiet window
  rather than being free to wake every motor at 03:00.
- `PowerViewHub.stopShade()`; `jogShade` and `stopShade` now share one `motionRequest` path.

## [3.1.4-local.6] - 2026-09-03

### Fixed

- **Position persistence in `local.5` never reached disk.** Mutating `accessory.context` does not
  write `cachedAccessories`; `api.updatePlatformAccessories()` is what schedules the save. Verified
  by inspecting the on-disk cache after a `local.5` restart — every `lastPositions` was absent.
  Now saved, guarded by `positionMapsEqual` so an ordinary read that changes nothing does not
  rewrite the cache file.

## [3.1.4-local.5] - 2026-09-03

### Fixed

- **`Invalid position value received` no longer fires on the happy path.** A PowerView Gen 2 hub
  returns no `positions` object at all on a cached read — positions exist only after a
  `refresh=true` read or a set — so the key was absent on *every* HomeKit position read and the
  warning fired 77 times in one day. Absent is now `debug` plus a once-per-shade `info`; only a
  key that is present with unusable data still warns, and the message now includes the value.
- **Last known positions persist across restarts.** They are written to accessory context and
  restored (validated) in `configureAccessory`, so a cold cache no longer falls through to
  `resolvePositionValue()`'s `0` — which reads as "fully closed" in the Home app until the
  background refresh lands, and sticks if that refresh times out.

### Changed

- `PositionMap` is now defined once in `shadeUtils.ts` instead of being redeclared in `platform.ts`.

## [3.1.4-local.4] - 2026-09-03

### Changed

- **Battery polling is now opt-in and off by default.** It previously ran every 6 hours on a
  timer anchored to plugin start, with no config option. `updateBatteryLevel=true` is an RF
  round-trip that wakes the shade motor — audible, and it nudges the shade — so on a 6-hour
  period at least one poll always landed overnight regardless of restart time. Observed waking
  a household at 05:54 (5 shades, ~4s each).
- Polling, when enabled, runs **once per day at a configurable local time** (`batteryPollAt`,
  default `14:00`) instead of on an interval. The next deadline is recomputed from the current
  time after every run, so the poll stays pinned to the same wall-clock time across DST changes.
- Battery poll runs are logged at `info`. The old poll logged nothing on success, which is why
  the shade movement could not be attributed from the default log.

### Added

- `batteryPolling` (boolean, default `false`) and `batteryPollAt` (`"HH:MM"`) config options,
  both exposed in the Homebridge UI schema.
- The battery poll timer is cleared on Homebridge `shutdown`.

### Notes

- Disabling the poll does not remove battery reporting: `batteryStrength` / `batteryStatus` ride
  along on ordinary hub reads and still update the HomeKit Battery service. The poll only forces
  a fresh measurement from the shade.

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
