# Changelog

All notable changes to this project are documented in this file.

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
