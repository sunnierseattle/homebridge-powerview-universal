import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';

import {
  HubPosition,
  PowerViewHub,
  type PowerViewShade,
} from './powerviewHub.js';
import {
  PowerViewPlatformAccessory,
  type CharacteristicCallback,
} from './platformAccessory.js';
import {
  PLUGIN_NAME,
  PLATFORM_NAME,
  SHADE_POLL_INTERVAL_MS,
  SHADE_TYPE_IDS,
  ShadeKind,
  SUBTYPE,
  type PowerViewPlatformConfig,
  type ShadeContext,
} from './settings.js';

export class PowerViewPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Record<number, PlatformAccessory<ShadeContext>> = {};
  private readonly handlers: Map<number, PowerViewPlatformAccessory> = new Map();

  public hubVersion?: string;
  private hubName?: string;

  private readonly hub: PowerViewHub;
  private readonly refreshShades: boolean;
  private readonly pollShadesForUpdate: boolean;
  private readonly forceRollerShades: number[];
  private readonly forceTopBottomShades: number[];
  private readonly forceHorizontalShades: number[];
  private readonly forceVerticalShades: number[];

  constructor(
    public readonly log: Logging,
    config: PowerViewPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('PowerView init');

    const host = config.host ?? 'powerview-hub.local';
    this.hub = new PowerViewHub(log, host);

    this.refreshShades = config.refreshShades === true;
    this.pollShadesForUpdate = config.pollShadesForUpdate === true;

    this.forceRollerShades = config.forceRollerShades ?? [];
    this.forceTopBottomShades = config.forceTopBottomShades ?? [];
    this.forceHorizontalShades = config.forceHorizontalShades ?? [];
    this.forceVerticalShades = config.forceVerticalShades ?? [];

    this.api.on('didFinishLaunching', () => {
      void this.onLaunch();
    });
  }

  private async onLaunch(): Promise<void> {
    try {
      await this.updateHubInfo();
      if (this.pollShadesForUpdate) {
        this.pollShades();
      } else {
        await this.updateShades();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('Failed to start PowerView platform:', message);
    }
  }

  shadeType(shade: PowerViewShade): ShadeKind {
    if (this.forceRollerShades.includes(shade.id)) {
      return ShadeKind.ROLLER;
    }
    if (this.forceTopBottomShades.includes(shade.id)) {
      return ShadeKind.TOP_BOTTOM;
    }
    if (this.forceHorizontalShades.includes(shade.id)) {
      return ShadeKind.HORIZONTAL;
    }
    if (this.forceVerticalShades.includes(shade.id)) {
      return ShadeKind.VERTICAL;
    }

    const type = shade.type ?? 0;
    if ((SHADE_TYPE_IDS.ROLLER as readonly number[]).includes(type)) {
      return ShadeKind.ROLLER;
    }
    if ((SHADE_TYPE_IDS.TOP_BOTTOM as readonly number[]).includes(type)) {
      return ShadeKind.TOP_BOTTOM;
    }
    if ((SHADE_TYPE_IDS.HORIZONTAL as readonly number[]).includes(type)) {
      return ShadeKind.HORIZONTAL;
    }
    if ((SHADE_TYPE_IDS.VERTICAL as readonly number[]).includes(type)) {
      return ShadeKind.VERTICAL;
    }

    this.log.warn(`Shade ${shade.id} has unknown type ${type}, assuming roller`);
    return ShadeKind.ROLLER;
  }

  configureAccessory(accessory: PlatformAccessory): void {
    const shadeAccessory = accessory as PlatformAccessory<ShadeContext>;
    this.log.info(
      'Cached shade %d: %s',
      shadeAccessory.context.shadeId,
      shadeAccessory.displayName,
    );

    if (!shadeAccessory.context.shadeType) {
      const topService = shadeAccessory.getServiceById(
        this.Service.WindowCovering.UUID,
        SUBTYPE.TOP,
      );
      shadeAccessory.context.shadeType = topService ? ShadeKind.TOP_BOTTOM : ShadeKind.ROLLER;
    }

    this.registerHandler(shadeAccessory);
  }

  private registerHandler(accessory: PlatformAccessory<ShadeContext>): void {
    const shadeId = accessory.context.shadeId;
    this.accessories[shadeId] = accessory;

    const handler = new PowerViewPlatformAccessory(this, accessory, this.log);
    this.handlers.set(shadeId, handler);
  }

  private addShadeAccessory(shade: PowerViewShade): PlatformAccessory<ShadeContext> {
    const name = Buffer.from(shade.name, 'base64').toString();
    this.log.info('Adding shade %d: %s', shade.id, name);

    const uuid = this.api.hap.uuid.generate(shade.id.toString());
    const accessory = new this.api.platformAccessory<ShadeContext>(name, uuid);
    accessory.context.shadeId = shade.id;
    accessory.context.shadeType = this.shadeType(shade);

    this.registerHandler(accessory);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);

    return accessory;
  }

  private updateShadeAccessory(shade: PowerViewShade): PlatformAccessory<ShadeContext> {
    const accessory = this.accessories[shade.id];
    this.log.info('Updating shade %d: %s', shade.id, accessory.displayName);

    const newType = this.shadeType(shade);
    const handler = this.handlers.get(shade.id);

    if (newType !== accessory.context.shadeType && handler) {
      this.log.info('Shade changed type %d -> %d', accessory.context.shadeType, newType);
      handler.shadeType = newType;
      handler.configure();
      this.api.updatePlatformAccessories([accessory]);
    }

    return accessory;
  }

  private removeShadeAccessory(accessory: PlatformAccessory<ShadeContext>): void {
    this.log.info('Removing shade %d: %s', accessory.context.shadeId, accessory.displayName);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    delete this.accessories[accessory.context.shadeId];
    this.handlers.delete(accessory.context.shadeId);
  }

  async updateShades(): Promise<void> {
    const shadeData = await this.hub.getShades();
    const newShades: Record<number, PlatformAccessory<ShadeContext>> = {};

    for (const shade of shadeData) {
      if (!this.accessories[shade.id]) {
        newShades[shade.id] = this.addShadeAccessory(shade);
      } else {
        newShades[shade.id] = this.updateShadeAccessory(shade);
      }

      const handler = this.handlers.get(shade.id);
      handler?.updateShadeValues(shade);
    }

    for (const shadeId of Object.keys(this.accessories)) {
      const id = parseInt(shadeId, 10);
      if (!newShades[id]) {
        this.removeShadeAccessory(this.accessories[id]);
      }
    }
  }

  private pollShades(): void {
    void this.updateShades().finally(() => {
      setTimeout(() => this.pollShades(), SHADE_POLL_INTERVAL_MS);
    });
  }

  async updateHubInfo(): Promise<void> {
    const userData = await this.hub.getUserData();
    this.hubName = Buffer.from(userData.hubName, 'base64').toString();
    if (userData.firmware?.mainProcessor) {
      this.hubVersion = userData.firmware.mainProcessor.name;
    }

    this.log.info('Hub: %s', this.hubName);

    for (const handler of this.handlers.values()) {
      handler.updateAccessoryInformation();
    }
  }

  private async updateShade(
    shadeId: number,
    refresh = false,
  ): Promise<{ positions: Partial<Record<HubPosition, number>> | null; timedOut?: boolean }> {
    const shade = await this.hub.getShade(shadeId, refresh);
    const handler = this.handlers.get(shadeId);
    const positions = handler?.updateShadeValues(shade) ?? null;
    return { positions, timedOut: refresh ? shade.timedOut : undefined };
  }

  async getPosition(
    shadeId: number,
    position: HubPosition,
    callback: CharacteristicCallback,
  ): Promise<void> {
    this.log.info('getPosition %d/%d', shadeId, position);

    try {
      const value = await this.updatePosition(shadeId, position, this.refreshShades);
      if (!this.refreshShades && value == null) {
        this.log.info('refresh %d/%d', shadeId, position);
        const refreshed = await this.updatePosition(shadeId, position, true);
        callback(null, refreshed ?? 0);
      } else {
        callback(null, value ?? 0);
      }
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async updatePosition(
    shadeId: number,
    position: HubPosition,
    refresh: boolean,
  ): Promise<number | null> {
    const { positions, timedOut } = await this.updateShade(shadeId, refresh);

    if (refresh && timedOut) {
      this.log.warn('Timeout for %d/%d', shadeId, position);
      throw new Error('Timed out');
    }

    if (!positions) {
      this.log.warn('Hub did not return positions for %d/%d', shadeId, position);
      return null;
    }

    const value = positions[position];
    if (typeof value === 'number' && Number.isFinite(value)) {
      this.log.info('updatePosition %d/%d: %d', shadeId, position, value);
      return value;
    }

    this.log.warn('Invalid position value received for %d/%d', shadeId, position);
    return 0;
  }

  async setPosition(
    shadeId: number,
    position: HubPosition,
    value: number,
    callback: (error: Error | null) => void,
  ): Promise<void> {
    this.log.info('setPosition %d/%d = %d', shadeId, position, value);

    if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
      callback(new Error(`Invalid value: ${value}`));
      return;
    }

    let hubValue: number;
    switch (position) {
    case HubPosition.BOTTOM:
    case HubPosition.TOP:
      hubValue = Math.round(65535 * value / 100);
      break;
    case HubPosition.VANES: {
      const accessory = this.accessories[shadeId];
      if (accessory.context.shadeType === ShadeKind.VERTICAL) {
        hubValue = Math.abs(Math.round(65535 * (value - 90) / 180));
      } else {
        hubValue = Math.round(32767 * value / 90);
      }
      break;
    }
    default:
      callback(new Error(`Unknown position: ${position}`));
      return;
    }

    try {
      const shade = await this.hub.putShade(shadeId, position, hubValue, value);
      const handler = this.handlers.get(shadeId);
      handler?.updateShadeValues(shade, true);
      callback(null);
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async jogShade(shadeId: number): Promise<Partial<Record<HubPosition, number>> | null> {
    const shade = await this.hub.jogShade(shadeId);
    const handler = this.handlers.get(shadeId);
    return handler?.updateShadeValues(shade) ?? null;
  }
}
