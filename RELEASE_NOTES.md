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

## Latest: 4.3.0 (2026-09-04)

### Highlights

- **Scenes, for shades that move together.** Any scene you define in the PowerView app now appears
  as a HomeKit switch. Activating it is one command to the hub, which moves the whole group at
  once — the same way a Pebble remote does, and something the plugin could not do by commanding
  shades one at a time.
- **The Home app stops claiming a shade has arrived before it has.** Position tiles now animate
  while the shade travels, showing opening or closing, instead of jumping to the destination the
  moment you tap.
- **Homebridge starts much faster.** The startup position sync no longer holds up launch; one
  observed startup took 82 seconds to become ready.

### Added

- `exposeScenes` (default on). Nothing appears unless you have scenes defined.

### Notes

- Scene activation follows the documented PowerView API but has not been tested against a live
  scene. If you define one and it misbehaves, that is the reason.

---

## 4.2.0 (2026-09-04)

### Highlights

- **The Home app feels faster.** Position reads are answered instantly from the last known
  position and refreshed in the background, instead of waiting on the hub. This removes the
  "plugin slows down Homebridge / read handler was slow to respond" warnings, which appeared 15
  times in a single startup on a five-shade system.
- **Reads never wake a shade motor.** The background refresh behind a read was using the RF
  round-trip that physically spins the shade; it now uses the cheap cached read, and the RF path
  is reserved for when the hub genuinely has no position.

---

## 4.1.2 (2026-09-04)

### Highlights

- **Shades can no longer vanish from HomeKit.** If the hub answered the shade-list request with a
  short list — which it does under load — the plugin removed every missing shade from HomeKit
  outright, losing its room and any automations using it. A shade now has to be missing from
  three consecutive responses before it is removed, and an empty response never removes anything.

### Notes

- If shades disappeared on an earlier version, restart Homebridge and they will be re-added. You
  may need to put them back in the right room in the Home app.

---

## 4.1.1 (2026-09-04)

Fixes a regression in 4.1.0.

### Highlights

- **Shades no longer drop out of a group move.** 4.1.0 tightened the gap between hub requests to
  25ms, which a gen1 hub cannot take while its radio is transmitting — it drops the connection,
  and the command was then lost rather than retried. Setting five shades at once could move only
  three. The spacing is back to 100ms, and a dropped connection is now retried.

### Notes

- `requestIntervalMs` remains configurable. If you retune it, test it with shades actually
  moving; cached reads will not reveal the problem.

---

## 4.1.0 (2026-09-04)

Responsiveness work on top of 4.0.0.

### Highlights

- **Shades react faster to a tap.** Commands from the Home app now jump ahead of background
  refreshes instead of queuing behind them, and the delay between hub requests drops from 100ms
  to 25ms — about 375ms off closing five shades.

### Added

- `requestIntervalMs` (default `25`) — raise it if your hub misbehaves under load.

### Notes

- This does **not** make shades move in unison. The hub takes one command per shade, so five
  shades means five round-trips and roughly 350ms of unavoidable spread. A remote looks
  synchronised because it broadcasts to all the motors at once over RF. Matching that through the
  hub needs scene support, which is not implemented yet.

---

## 4.0.0 (2026-09-04)

First release under the name **homebridge-powerview-universal**. A major version
because the package is renamed — this does not upgrade in place.

### Highlights

- **Your shades stop waking up at night.** Battery polling was an RF round-trip that spins the
  motor, ran every 6 hours from plugin start, and had no off switch — so a poll always landed
  overnight. It is now off by default, and opt-in polling runs once a day at a time you choose.
- **Positions are correct on a cold start.** Last known positions survive a restart, so shades no
  longer show as "fully closed" in the Home app while the first refresh is still in flight.
- **The Home app stops timing out.** Position reads answer instantly from cache and refresh in the
  background, instead of blocking on a hub round-trip that HomeKit gives up on.
- **Battery percentages above 90% are real numbers now**, and 20 more shade types are driven from
  the capabilities the hub reports rather than assumed to be rollers.

### Added

- `batteryPolling` (default `false`) and `batteryPollAt` (default `14:00`) — opt in to a daily
  battery measurement at a time that suits you.
- `syncPositionsOnStart` (default `true`) and `quietHours` (default 21:00–08:00) — re-sync unknown
  positions at startup, but never inside the quiet window.
- An ISC `LICENSE` file.

### Changed

- Shade behaviour comes from the hub's `capabilities` field, falling back to the documented
  26-type table. Types the plugin cannot yet drive correctly now warn once per shade instead of
  silently reporting a wrong position or tilt.
- Logs are much quieter: positions are logged only when they change, and the "invalid position"
  and low-battery warnings no longer fire on the happy path.

### Fixed

- **Tilting a blind no longer makes it report as fully closed.** Whenever the hub sent a tilt
  value, the shade's position was overwritten with 0 in the same update.
- **Restarting Homebridge no longer shows every shade as fully closed** until the first refresh
  lands.
- **Hold** now stops a moving shade instead of jogging it.
- Battery percentage is read as pack voltage, not as a percentage — previously anything above 100
  collapsed to one of four values, so 67% and 98% both showed as 90%.
- Hub requests time out after 15s instead of hanging forever, and every request is fully
  serialised — including reading the response body, which previously still overlapped the next
  request and left the hub returning truncated JSON.
- A poll now costs half the hub requests it used to.
- Shades that the hub has never polled no longer raise a false low-battery warning.

### Notes

- Requires Homebridge **1.8+** or **2.x** and Node **22** or **24**.
- **Uninstall `homebridge-powerview-3` before installing this package.** Homebridge migrates your
  cached shades to the new name automatically, but only if one plugin claims the `PowerView`
  platform name — with both installed, the cached accessories are dropped and your shades come
  back as new tiles.
- Your `config.json` needs no changes; all new options have defaults.
- PowerView **scenes** are probed at startup but still not exposed as HomeKit accessories.

---

## 3.1.2 (2026-05-18)

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
