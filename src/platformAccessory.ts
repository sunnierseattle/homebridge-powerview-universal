import type {
  CharacteristicValue,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';

import { HubPosition, type PowerViewShade } from './powerviewHub.js';
import type { PowerViewPlatform } from './platform.js';
import {
  POSITION_KIND_ERROR,
  decodeBase64Name,
  formatShadeFirmware,
  resolveBatteryReading,
} from './shadeUtils.js';
import { ShadeKind, SUBTYPE, type ShadeContext } from './settings.js';

type PositionMap = Partial<Record<HubPosition, number>> | null;

export class PowerViewPlatformAccessory {
  private lastShade?: PowerViewShade;
  private holdPositionWired = false;

  constructor(
    private readonly platform: PowerViewPlatform,
    public readonly accessory: PlatformAccessory<ShadeContext>,
    private readonly log: Logging,
  ) {
    this.configure();
    this.updateAccessoryInformation();
  }

  private get Service() {
    return this.platform.Service;
  }

  private get Characteristic() {
    return this.platform.Characteristic;
  }

  get shadeId(): number {
    return this.accessory.context.shadeId;
  }

  get shadeType(): ShadeKind {
    return this.accessory.context.shadeType;
  }

  set shadeType(type: ShadeKind) {
    this.accessory.context.shadeType = type;
  }

  /**
   * Finds a Window Covering service by subtype, including cached accessories that
   * predate subtypes (empty subtype on a single covering service).
   */
  private resolveWindowCoveringService(subtype: string): Service | undefined {
    const match = this.accessory.getServiceById(this.Service.WindowCovering, subtype);
    if (match) {
      return match;
    }

    if (subtype === SUBTYPE.BOTTOM) {
      const legacy = this.accessory.getService(this.Service.WindowCovering);
      if (legacy && legacy.subtype !== SUBTYPE.TOP) {
        return legacy;
      }
    }

    return undefined;
  }

  private ensureWindowCoveringService(subtype: string, displayName?: string): Service {
    const existing = this.resolveWindowCoveringService(subtype);
    if (existing) {
      if (displayName) {
        existing.setCharacteristic(this.Characteristic.Name, displayName);
      }
      return existing;
    }

    return this.accessory.addService(
      this.Service.WindowCovering,
      displayName ?? this.accessory.displayName,
      subtype,
    );
  }

  private wireTargetPositionGet(service: Service): void {
    service
      .getCharacteristic(this.Characteristic.TargetPosition)
      .removeAllListeners('get')
      .on('get', (callback) => {
        const current = service.getCharacteristic(this.Characteristic.CurrentPosition).value;
        callback(null, typeof current === 'number' ? current : 0);
      });
  }

  private wireHoldPosition(service: Service): void {
    if (this.holdPositionWired || this.accessory.context.jogSupported === false) {
      return;
    }

    const hold = service.getCharacteristic(this.Characteristic.HoldPosition);
    hold.removeAllListeners('set');
    hold.on('set', (value, callback) => {
      if (value === true || value === 1) {
        void this.platform.jogShade(this.shadeId).then(() => {
          callback(null);
        }).catch((err) => {
          callback(err instanceof Error ? err : new Error(String(err)));
        });
      } else {
        callback(null);
      }
    });
    this.holdPositionWired = true;
  }

  private wireIdentify(): void {
    const info = this.accessory.getService(this.Service.AccessoryInformation);
    if (!info) {
      return;
    }

    info
      .getCharacteristic(this.Characteristic.Identify)
      .removeAllListeners('set')
      .on('set', () => {
        void this.platform.jogShadeOnIdentify(this.shadeId);
      });
  }

  /** Keeps current/target in sync and reports stopped so HomeKit/Homebridge do not show movement. */
  private applyCoveringPosition(service: Service, value: number): void {
    if (Number.isNaN(value)) {
      return;
    }

    service.setCharacteristic(this.Characteristic.CurrentPosition, value);
    service.updateCharacteristic(this.Characteristic.TargetPosition, value);
    service.setCharacteristic(
      this.Characteristic.PositionState,
      this.Characteristic.PositionState.STOPPED,
    );
  }

  configure(): void {
    const shadeId = this.shadeId;
    const topDisplayName = this.lastShade?.secondaryName
      ? decodeBase64Name(this.lastShade.secondaryName, this.accessory.displayName)
      : undefined;

    const service = this.ensureWindowCoveringService(SUBTYPE.BOTTOM);
    this.applyCoveringPosition(service, 0);

    service
      .getCharacteristic(this.Characteristic.CurrentPosition)
      .removeAllListeners('get')
      .on('get', (callback) => {
        void this.platform.getPosition(shadeId, HubPosition.BOTTOM, callback);
      });

    this.wireTargetPositionGet(service);
    this.wireHoldPosition(service);

    service
      .getCharacteristic(this.Characteristic.TargetPosition)
      .removeAllListeners('set')
      .on('set', (value, callback) => {
        void this.platform.setPosition(shadeId, HubPosition.BOTTOM, value as number, callback);
      });

    if (this.shadeType === ShadeKind.HORIZONTAL) {
      service
        .getCharacteristic(this.Characteristic.CurrentHorizontalTiltAngle)
        .setProps({ minValue: 0 })
        .removeAllListeners('get')
        .on('get', (callback) => {
          void this.platform.getPosition(shadeId, HubPosition.VANES, callback);
        });

      service
        .getCharacteristic(this.Characteristic.TargetHorizontalTiltAngle)
        .setProps({ minValue: 0 })
        .removeAllListeners('set')
        .on('set', (value, callback) => {
          void this.platform.setPosition(shadeId, HubPosition.VANES, value as number, callback);
        });
    } else {
      this.resetOptionalTiltCharacteristics(service, 'horizontal');
    }

    if (this.shadeType === ShadeKind.VERTICAL) {
      service
        .getCharacteristic(this.Characteristic.CurrentVerticalTiltAngle)
        .removeAllListeners('get')
        .on('get', (callback) => {
          void this.platform.getPosition(shadeId, HubPosition.VANES, callback);
        });

      service
        .getCharacteristic(this.Characteristic.TargetVerticalTiltAngle)
        .removeAllListeners('set')
        .on('set', (value, callback) => {
          void this.platform.setPosition(shadeId, HubPosition.VANES, value as number, callback);
        });
    } else {
      this.resetOptionalTiltCharacteristics(service, 'vertical');
    }

    let topService = this.resolveWindowCoveringService(SUBTYPE.TOP);
    if (this.shadeType === ShadeKind.TOP_BOTTOM) {
      if (!topService) {
        topService = this.ensureWindowCoveringService(SUBTYPE.TOP, topDisplayName);
      } else if (topDisplayName) {
        topService.setCharacteristic(this.Characteristic.Name, topDisplayName);
      }
      this.applyCoveringPosition(topService, 0);

      topService
        .getCharacteristic(this.Characteristic.CurrentPosition)
        .removeAllListeners('get')
        .on('get', (callback) => {
          void this.platform.getPosition(shadeId, HubPosition.TOP, callback);
        });

      this.wireTargetPositionGet(topService);

      topService
        .getCharacteristic(this.Characteristic.TargetPosition)
        .removeAllListeners('set')
        .on('set', (value, callback) => {
          void this.platform.setPosition(shadeId, HubPosition.TOP, value as number, callback);
        });
    } else if (topService) {
      this.accessory.removeService(topService);
    }

    this.wireIdentify();
    this.updateAccessoryInformation();
  }

  private resetOptionalTiltCharacteristics(
    service: Service,
    axis: 'horizontal' | 'vertical',
  ): void {
    const targets = axis === 'horizontal'
      ? [
        this.Characteristic.TargetHorizontalTiltAngle,
        this.Characteristic.CurrentHorizontalTiltAngle,
      ]
      : [
        this.Characteristic.TargetVerticalTiltAngle,
        this.Characteristic.CurrentVerticalTiltAngle,
      ];

    for (const characteristic of targets) {
      if (service.testCharacteristic(characteristic)) {
        const ch = service.getCharacteristic(characteristic);
        service.removeCharacteristic(ch);
        service.addOptionalCharacteristic(characteristic);
      }
    }
  }

  /**
   * HomeKit shows battery % via a linked {@link Service.Battery} service (not on Window Covering).
   * AccessoryInformation.StatusLowBattery alone only drives the low-battery warning state.
   */
  private updateBatteryService(shade: PowerViewShade | undefined): void {
    const reading = shade
      ? resolveBatteryReading(shade.batteryStatus, shade.batteryStrength)
      : undefined;

    const existing = this.accessory.getService(this.Service.Battery);
    if (!reading) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }

    const batteryService = existing
      ?? this.accessory.addService(this.Service.Battery, `${this.accessory.displayName} Battery`);

    batteryService
      .updateCharacteristic(this.Characteristic.BatteryLevel, reading.level)
      .updateCharacteristic(
        this.Characteristic.StatusLowBattery,
        reading.low
          ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );

    const chargingState = reading.mainsPowered
      ? this.Characteristic.ChargingState.NOT_CHARGEABLE
      : this.Characteristic.ChargingState.NOT_CHARGING;
    batteryService.updateCharacteristic(this.Characteristic.ChargingState, chargingState);

    const primary = this.resolveWindowCoveringService(SUBTYPE.BOTTOM)
      ?? this.accessory.getService(this.Service.WindowCovering);
    if (primary && typeof primary.addLinkedService === 'function') {
      try {
        primary.addLinkedService(batteryService);
      } catch {
        // Already linked or platform does not support linking.
      }
    }
  }

  updateAccessoryInformation(shade?: PowerViewShade): void {
    const shadeData = shade ?? this.lastShade;
    let info = this.accessory.getService(this.Service.AccessoryInformation);
    if (!info) {
      info = this.accessory.addService(this.Service.AccessoryInformation);
    }

    info.setCharacteristic(this.Characteristic.Manufacturer, 'Hunter Douglas');
    info.setCharacteristic(
      this.Characteristic.Model,
      this.platform.hubVersion ?? 'PowerView',
    );
    info.setCharacteristic(this.Characteristic.SerialNumber, String(this.shadeId));

    const firmwareRevision = formatShadeFirmware(shadeData?.firmware);
    if (firmwareRevision) {
      info.setCharacteristic(this.Characteristic.FirmwareRevision, firmwareRevision);
    }

    // StatusLowBattery is not a valid characteristic on AccessoryInformation; setting
    // it here made Homebridge log a warning for every shade on every refresh. The
    // Battery service (below) is the correct and only place for it.
    this.updateBatteryService(shadeData);
  }

  updateShadeValues(shade: PowerViewShade, current = false): PositionMap {
    this.lastShade = shade;
    const positions: PositionMap = {};

    if (shade.secondaryName && this.shadeType === ShadeKind.TOP_BOTTOM) {
      const topService = this.resolveWindowCoveringService(SUBTYPE.TOP);
      const topName = decodeBase64Name(shade.secondaryName, this.accessory.displayName);
      if (topService) {
        topService.setCharacteristic(this.Characteristic.Name, topName);
      }
    }

    this.updateAccessoryInformation(shade);

    if (!shade.positions) {
      this.platform.cachePositions(shade.id, positions);
      return positions;
    }

    this.log.info('Set for', shade.id, { positions: shade.positions });

    for (let i = 1; shade.positions[`posKind${i}`] != null; ++i) {
      const position = shade.positions[`posKind${i}`];
      const hubValue = shade.positions[`position${i}`];

      if (position === POSITION_KIND_ERROR) {
        this.platform.warnPositionKindErrorOnce(shade.id);
        continue;
      }

      if (position === HubPosition.BOTTOM) {
        positions[HubPosition.BOTTOM] = Math.round(100 * hubValue / 65535);
        const service = this.resolveWindowCoveringService(SUBTYPE.BOTTOM);
        if (!service) {
          this.log.warn('No bottom Window Covering service for shade %d', shade.id);
          continue;
        }

        if (!Number.isNaN(positions[HubPosition.BOTTOM])) {
          if (current) {
            this.log.info('Setting position to:', positions[HubPosition.BOTTOM]);
          }
          this.applyCoveringPosition(service, positions[HubPosition.BOTTOM]!);
        } else {
          this.log.warn('Invalid position value:', positions[HubPosition.BOTTOM]);
        }

        if (this.shadeType === ShadeKind.HORIZONTAL && current) {
          service.setCharacteristic(this.Characteristic.CurrentHorizontalTiltAngle, 0);
          service.updateCharacteristic(this.Characteristic.TargetHorizontalTiltAngle, 0);
        }

        if (this.shadeType === ShadeKind.VERTICAL && current) {
          service.setCharacteristic(this.Characteristic.CurrentVerticalTiltAngle, 0);
          service.updateCharacteristic(this.Characteristic.TargetVerticalTiltAngle, 0);
        }
      }

      if (position === HubPosition.VANES && this.shadeType === ShadeKind.HORIZONTAL) {
        positions[HubPosition.VANES] = Math.round(90 * hubValue / 32767);
        const service = this.resolveWindowCoveringService(SUBTYPE.BOTTOM);
        if (!service) {
          continue;
        }

        this.applyCoveringPosition(service, 0);

        if (current && !Number.isNaN(positions[HubPosition.VANES])) {
          service.setCharacteristic(
            this.Characteristic.CurrentHorizontalTiltAngle,
            positions[HubPosition.VANES]!,
          );
        }
        if (!Number.isNaN(positions[HubPosition.VANES])) {
          service.updateCharacteristic(
            this.Characteristic.TargetHorizontalTiltAngle,
            positions[HubPosition.VANES]!,
          );
        }
      }

      if (position === HubPosition.VANES && this.shadeType === ShadeKind.VERTICAL) {
        positions[HubPosition.VANES] = 90 - Math.round(180 * hubValue / 65535);
        const service = this.resolveWindowCoveringService(SUBTYPE.BOTTOM);
        if (!service) {
          continue;
        }

        this.applyCoveringPosition(service, 0);

        if (current) {
          service.setCharacteristic(
            this.Characteristic.CurrentVerticalTiltAngle,
            positions[HubPosition.VANES]!,
          );
        }
        service.updateCharacteristic(
          this.Characteristic.TargetVerticalTiltAngle,
          positions[HubPosition.VANES]!,
        );
      }

      if (position === HubPosition.TOP && this.shadeType === ShadeKind.TOP_BOTTOM) {
        positions[HubPosition.TOP] = Math.round(100 * hubValue / 65535);
        const service = this.resolveWindowCoveringService(SUBTYPE.TOP);
        if (!service) {
          continue;
        }

        if (!Number.isNaN(positions[HubPosition.TOP])) {
          this.applyCoveringPosition(service, positions[HubPosition.TOP]!);
        }
      }
    }

    this.platform.cachePositions(shade.id, positions);
    return positions;
  }
}

export type CharacteristicCallback = (
  error: Error | null,
  value?: CharacteristicValue,
) => void;
