# homebridge-powerview-3

[![npm](https://img.shields.io/npm/v/homebridge-powerview-3.svg)](https://www.npmjs.com/package/homebridge-powerview-3)
[![npm](https://img.shields.io/npm/dt/homebridge-powerview-3.svg)](https://www.npmjs.com/package/homebridge-powerview-3)

Homebridge plugin for [Hunter Douglas PowerView](https://www.hunterdouglas.com/operating-systems/motorized/powerview-motorization) window shades. Compatible with **Homebridge 1.8+** and **Homebridge 2.x** (Node.js 22 or 24).

Supports Generation 1 and 2 PowerView hubs.

## Requirements

- [Homebridge](https://github.com/homebridge/homebridge) **1.8.0** or **2.0.0**
- Node.js **22** or **24**

## Supported shades

- Roller shades
- Horizontal vane shades (e.g. Silhouette, Pirouette) — position plus tilt in Details
- Vertical vane shades (e.g. Luminette) — position plus tilt in Details
- Top-down/bottom-up shades (e.g. Duette) — two Window Covering services per shade

Shades work in HomeKit scenes and automations.

## Installation

1. Install and set up [Homebridge](https://github.com/homebridge/homebridge).
2. Install the plugin (Homebridge UI **Plugins** tab, or CLI):

```bash
npm install -g homebridge-powerview-3
```

3. Add the **PowerView** platform via the plugin **Settings** button in the Homebridge UI, or add a platform block to `config.json`:

```json
"platforms": [
  {
    "platform": "PowerView",
    "name": "PowerView"
  }
]
```

The hub is contacted at `powerview-hub.local` by default.

## Configuration

| Option | Description | Default |
|--------|-------------|---------|
| `name` | Platform name in Homebridge | `PowerView` |
| `host` | Hub hostname or IP | `powerview-hub.local` |
| `refreshShades` | Request fresh positions from the hub on every HomeKit read | `false` |
| `pollShadesForUpdate` | Poll the hub every 30 seconds for position updates | `false` |
| `strictErrors` | Fail HomeKit reads on hub errors instead of returning the last known position | `false` |
| `forceRollerShades` | Shade IDs to treat as roller | `[]` |
| `forceTopBottomShades` | Shade IDs to treat as top/bottom | `[]` |
| `forceHorizontalShades` | Shade IDs to treat as horizontal vane | `[]` |
| `forceVerticalShades` | Shade IDs to treat as vertical vane | `[]` |

Example with host and polling:

```json
{
  "platform": "PowerView",
  "name": "PowerView",
  "host": "192.168.1.50",
  "pollShadesForUpdate": true
}
```

### Unknown shade types

If the hub reports an unknown shade type, the log may show:

```
Shade 12345 has unknown type 66, assuming roller
```

Please [open an issue](https://github.com/squircle12/homebridge-powerview-3/issues) with the shade model. You can override detection with the `force*` arrays above.

### Hub resilience and optional features

- If the hub is busy (HTTP 423, maintenance), shade requests are retried automatically.
- When a position refresh times out or the hub is unreachable, HomeKit reads return the **last known position** unless `strictErrors` is enabled.
- **Battery** percentage appears in the Home app (via a linked HomeKit Battery service on each shade) when the hub reports `batteryStrength` or `batteryStatus`; levels are refreshed about every 6 hours. Window Covering does not expose battery directly—only the standard Battery service does.
- **Jog** (short nudge) is triggered from **Hold** on the shade control where supported, and when you **Identify** the accessory in the Home app while pairing.
- PowerView **scenes** and **multi-room scene collections** are probed at startup for future use but are **not** exposed as HomeKit accessories yet.

## Migrating from homebridge-powerview-2

1. Stop Homebridge.
2. Uninstall the old plugin: `npm uninstall -g homebridge-powerview-2`
3. Install `homebridge-powerview-3`.
4. Update your config: keep `"platform": "PowerView"` and add `"name": "PowerView"` if missing.
5. Remove any old **PowerView** platform entry that pointed at the v2 package, then add the platform again for v3.
6. Restart Homebridge.

The plugin identifier changed from `homebridge-powerview` to `homebridge-powerview-3`. Cached accessories from the old package may appear as duplicates in the Home app. Remove ghost accessories from Home if needed.

## Shade examples

Tap an accessory to open/close; long-press for a custom position.

### Horizontal and vertical vanes

Use **Details** after a long-press to adjust tilt. For scenes: use **Closed** when setting vane tilt; use **0°** tilt when setting position.

### Top-down/bottom-up

Two controls are created per shade (bottom and top), which can be used independently or in scenes.

## Development

```bash
npm install
npm run build
npm run lint
npm test
```

## License

ISC
