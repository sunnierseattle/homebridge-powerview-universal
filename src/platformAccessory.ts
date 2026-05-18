import type {
  CharacteristicValue,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';

import { HubPosition, type PowerViewShade } from './powerviewHub.js';
import type { PowerViewPlatform } from './platform.js';
import { ShadeKind, SUBTYPE, type ShadeContext } from './settings.js';

type PositionMap = Partial<Record<HubPosition, number>> | null;

export class PowerViewPlatformAccessory {
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

  private windowCoveringService(subtype: string): Service | undefined {
    return this.accessory.getServiceById(this.Service.WindowCovering, subtype);
  }

  /**
   * Returns an existing Window Covering service or creates one. Uses the Service
   * constructor (not UUID string) for lookup per HAP-NodeJS getServiceById API.
   */
  private ensureWindowCoveringService(subtype: string): Service {
    const existing = this.windowCoveringService(subtype);
    if (existing) {
      return existing;
    }

    // Cached accessories from older plugin versions may have no subtype on a single service.
    if (subtype === SUBTYPE.BOTTOM) {
      const legacy = this.accessory.getService(this.Service.WindowCovering);
      if (legacy) {
        return legacy;
      }
    }

    return this.accessory.addService(
      this.Service.WindowCovering,
      this.accessory.displayName,
      subtype,
    );
  }

  private setCoveringStopped(service: Service): void {
    service.updateCharacteristic(
      this.Characteristic.PositionState,
      this.Characteristic.PositionState.STOPPED,
    );
  }

  configure(): void {
    const shadeId = this.shadeId;

    const service = this.ensureWindowCoveringService(SUBTYPE.BOTTOM);
    this.setCoveringStopped(service);

    service
      .getCharacteristic(this.Characteristic.CurrentPosition)
      .removeAllListeners('get')
      .on('get', (callback) => {
        void this.platform.getPosition(shadeId, HubPosition.BOTTOM, callback);
      });

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

    let topService = this.windowCoveringService(SUBTYPE.TOP);
    if (this.shadeType === ShadeKind.TOP_BOTTOM) {
      if (!topService) {
        topService = this.ensureWindowCoveringService(SUBTYPE.TOP);
      }
      this.setCoveringStopped(topService);

      topService
        .getCharacteristic(this.Characteristic.CurrentPosition)
        .removeAllListeners('get')
        .on('get', (callback) => {
          void this.platform.getPosition(shadeId, HubPosition.TOP, callback);
        });

      topService
        .getCharacteristic(this.Characteristic.TargetPosition)
        .removeAllListeners('set')
        .on('set', (value, callback) => {
          void this.platform.setPosition(shadeId, HubPosition.TOP, value as number, callback);
        });
    } else if (topService) {
      this.accessory.removeService(topService);
    }

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

  updateAccessoryInformation(): void {
    let info = this.accessory.getService(this.Service.AccessoryInformation);
    if (!info) {
      info = this.accessory.addService(this.Service.AccessoryInformation);
    }
    info
      .setCharacteristic(this.Characteristic.Manufacturer, 'Hunter Douglas')
      .setCharacteristic(
        this.Characteristic.Model,
        this.platform.hubVersion ?? 'PowerView',
      );
  }

  updateShadeValues(shade: PowerViewShade, current = false): PositionMap {
    const positions: PositionMap = {};

    if (!shade.positions) {
      return positions;
    }

    this.log.info('Set for', shade.id, { positions: shade.positions });

    for (let i = 1; shade.positions[`posKind${i}`]; ++i) {
      const position = shade.positions[`posKind${i}`];
      const hubValue = shade.positions[`position${i}`];

      if (position === HubPosition.BOTTOM) {
        positions[HubPosition.BOTTOM] = Math.round(100 * hubValue / 65535);
        const service = this.windowCoveringService(SUBTYPE.BOTTOM);
        if (!service) {
          continue;
        }

        if (current) {
          this.log.info('Setting CurrentPosition to:', positions[HubPosition.BOTTOM]);
          if (!Number.isNaN(positions[HubPosition.BOTTOM])) {
            service.setCharacteristic(
              this.Characteristic.CurrentPosition,
              positions[HubPosition.BOTTOM]!,
            );
          } else {
            this.log.warn('Invalid position value:', positions[HubPosition.BOTTOM]);
          }
        }

        if (!Number.isNaN(positions[HubPosition.BOTTOM])) {
          service.updateCharacteristic(
            this.Characteristic.TargetPosition,
            positions[HubPosition.BOTTOM]!,
          );
        }

        service.setCharacteristic(
          this.Characteristic.PositionState,
          this.Characteristic.PositionState.STOPPED,
        );

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
        const service = this.windowCoveringService(SUBTYPE.BOTTOM);
        if (!service) {
          continue;
        }

        if (current) {
          service.setCharacteristic(this.Characteristic.CurrentPosition, 0);
        }
        service.updateCharacteristic(this.Characteristic.TargetPosition, 0);
        service.setCharacteristic(
          this.Characteristic.PositionState,
          this.Characteristic.PositionState.STOPPED,
        );

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
        const service = this.windowCoveringService(SUBTYPE.BOTTOM);
        if (!service) {
          continue;
        }

        if (current) {
          service.setCharacteristic(this.Characteristic.CurrentPosition, 0);
        }
        service.updateCharacteristic(this.Characteristic.TargetPosition, 0);
        service.setCharacteristic(
          this.Characteristic.PositionState,
          this.Characteristic.PositionState.STOPPED,
        );

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
        const service = this.windowCoveringService(SUBTYPE.TOP);
        if (!service) {
          continue;
        }

        if (current) {
          service.setCharacteristic(
            this.Characteristic.CurrentPosition,
            positions[HubPosition.TOP]!,
          );
        }
        service.updateCharacteristic(
          this.Characteristic.TargetPosition,
          positions[HubPosition.TOP]!,
        );
        service.setCharacteristic(
          this.Characteristic.PositionState,
          this.Characteristic.PositionState.STOPPED,
        );
      }
    }

    return positions;
  }
}

export type CharacteristicCallback = (
  error: Error | null,
  value?: CharacteristicValue,
) => void;
