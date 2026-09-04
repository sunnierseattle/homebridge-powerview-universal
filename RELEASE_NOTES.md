# Release notes

User-facing notes for **homebridge-powerview-universal** releases. Use this file when publishing to npm or creating a [GitHub Release](https://github.com/sunnierseattle/homebridge-powerview-universal/releases).

## How to publish a version

1. Bump `version` in [package.json](package.json).
2. Add a new **Latest** section below (copy the template).
3. Record the same changes in [CHANGELOG.md](CHANGELOG.md) (developer-oriented, can be more detailed).
4. Run `npm test`, `npm run build`, then publish or tag.
5. Copy the **Latest** section into the GitHub Release description (title: `vX.Y.Z`).

### Section template

```markdown
## Latest: X.Y.Z (YYYY-MM-DD)

### Highlights

- One-line summary for installers (1–3 bullets).

### Added

- …

### Changed

- …

### Fixed

- …

### Notes

- Upgrade / config / HomeKit caveats if any.
```

---

## Latest: 3.1.2 (2026-05-18)

### Highlights

- Battery percentage now appears in the Home app via a linked HomeKit Battery service on each shade (when the hub reports battery data).
- More resilient hub communication: retries when the hub is busy, cached positions on refresh timeouts, and optional `strictErrors` for debugging.

### Added

- Linked **Battery** service per shade (`BatteryLevel` 0–100%) from hub `batteryStrength` / `batteryStatus`.
- Hub HTTP **423** retry, startup capability probes, position **cache** for failed reads/refreshes.
- Platform option **`strictErrors`** (default `false`).
- Per-shade **firmware** in Accessory Information; **low battery** warning; TDBU top-rail name from `secondaryName`.
- **Hold** and **Identify** trigger shade **jog** where the hub supports it.
- Periodic battery refresh (`updateBatteryLevel`, about every 6 hours).

### Changed

- Shade list failures during poll no longer remove existing accessories.
- `putShade` omits invalid hub position kind **4** (error) from merged updates.

### Notes

- Requires Homebridge **1.8+** or **2.x** and Node **22** or **24**.
- PowerView **scenes** are probed at startup but not exposed as HomeKit accessories yet.
- After upgrading, restart Homebridge; remove duplicate shade tiles in Home if you migrated from an older plugin id.

---

## 3.1.1 (2026-05-18)

- Linked HomeKit Battery service per shade (battery % in Home app).

## 3.1.0 (2026-05-18)

- Hub resilience, `strictErrors`, position cache, battery/firmware metadata, jog via Hold/Identify, unit tests.

## 3.0.0 (2026-05-17)

- **Breaking:** Package renamed to `homebridge-powerview-3`; Homebridge 2.x / Node 22–24; TypeScript rewrite.
- See [CHANGELOG.md](CHANGELOG.md) for migration from homebridge-powerview-2.

## Earlier versions

See [CHANGELOG.md](CHANGELOG.md) and [homebridge-powerview-2](https://github.com/owenselles/homebridge-powerview-2).
