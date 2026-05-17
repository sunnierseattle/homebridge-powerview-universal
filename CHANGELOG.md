# Changelog

All notable changes to this project are documented in this file.

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
