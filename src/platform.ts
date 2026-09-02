import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';

import {
  HubError,
  HubErrorCode,
  formatError,
  isHubError,
  logError,
  registerProcessErrorHandlers,
} from './errors.js';
import { type HubCapabilities, probeHubCapabilities } from './hubCapabilities.js';
import {
  HubPosition,
  PowerViewHub,
  type PowerViewShade,
} from './powerviewHub.js';
import {
  PowerViewPlatformAccessory,
  type CharacteristicCallback,
} from './platformAccessory.js';
import { POSITION_KIND_ERROR, decodeBase64Name } from './shadeUtils.js';
import {
  BATTERY_POLL_INTERVAL_MS,
  PLUGIN_NAME,
  PLATFORM_NAME,
  SHADE_POLL_INTERVAL_MS,
  SHADE_TYPE_IDS,
  ShadeKind,
  SUBTYPE,
  type PowerViewPlatformConfig,
  type ShadeContext,
} from './settings.js';

function shadeIdArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((id): id is number => typeof id === 'number') : [];
}

type PositionMap = Partial<Record<HubPosition, number>>;

export class PowerViewPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Record<number, PlatformAccessory<ShadeContext>> = {};
  private readonly handlers: Map<number, PowerViewPlatformAccessory> = new Map();

  public hubVersion?: string;
  public hubCapabilities?: HubCapabilities;
  private hubName?: string;

  private readonly hub: PowerViewHub;
  private readonly refreshShades: boolean;
  private readonly pollShadesForUpdate: boolean;
  private readonly strictErrors: boolean;
  private readonly forceRollerShades: number[];
  private readonly forceTopBottomShades: number[];
  private readonly forceHorizontalShades: number[];
  private readonly forceVerticalShades: number[];

  private readonly lastPositions = new Map<number, PositionMap>();

  /** Shades with a background refresh already in flight, so reads don't pile up. */
  private readonly pendingRefresh = new Set<number>();
  private readonly batteryRefreshDisabled = new Set<number>();
  private readonly posKindErrorLogged = new Set<number>();
  private batteryPollTimer?: ReturnType<typeof setInterval>;

  constructor(
    public readonly log: Logging,
    config: PowerViewPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('PowerView init');

    registerProcessErrorHandlers(this.log, PLUGIN_NAME);

    const host = typeof config.host === 'string' && config.host.length > 0
      ? config.host
      : 'powerview-hub.local';
    this.hub = new PowerViewHub(log, host);

    this.refreshShades = config.refreshShades === true;
    this.pollShadesForUpdate = config.pollShadesForUpdate === true;
    this.strictErrors = config.strictErrors === true;

    this.forceRollerShades = shadeIdArray(config.forceRollerShades);
    this.forceTopBottomShades = shadeIdArray(config.forceTopBottomShades);
    this.forceHorizontalShades = shadeIdArray(config.forceHorizontalShades);
    this.forceVerticalShades = shadeIdArray(config.forceVerticalShades);

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
      this.scheduleBatteryPoll();
    } catch (err) {
      logError(this.log, 'Failed to start PowerView platform:', err);
    }
  }

  cachePositions(shadeId: number, positions: PositionMap | null): void {
    if (!positions) {
      return;
    }
    const existing = this.lastPositions.get(shadeId) ?? {};
    this.lastPositions.set(shadeId, { ...existing, ...positions });
  }

  getCachedPosition(shadeId: number, position: HubPosition): number | undefined {
    const cached = this.lastPositions.get(shadeId)?.[position];
    return typeof cached === 'number' && Number.isFinite(cached) ? cached : undefined;
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
    try {
      const shadeAccessory = accessory as PlatformAccessory<ShadeContext>;
      const shadeId = shadeAccessory.context.shadeId;

      if (typeof shadeId !== 'number' || !Number.isFinite(shadeId)) {
        this.log.error(
          'Cached accessory "%s" is missing a valid shadeId; remove it from Homebridge or re-discover shades.',
          accessory.displayName,
        );
        return;
      }

      this.log.info('Cached shade %d: %s', shadeId, shadeAccessory.displayName);

      this.ensureWindowCoveringCategory(shadeAccessory);

      if (!shadeAccessory.context.shadeType) {
        const topService = shadeAccessory.getServiceById(
          this.Service.WindowCovering,
          SUBTYPE.TOP,
        );
        shadeAccessory.context.shadeType = topService ? ShadeKind.TOP_BOTTOM : ShadeKind.ROLLER;
      }

      if (shadeAccessory.context.jogSupported === undefined) {
        shadeAccessory.context.jogSupported = true;
      }

      this.registerHandler(shadeAccessory);
    } catch (err) {
      logError(
        this.log,
        `Failed to configure cached accessory "${accessory.displayName}":`,
        err,
      );
    }
  }

  private ensureWindowCoveringCategory(accessory: PlatformAccessory<ShadeContext>): void {
    const category = this.api.hap.Categories.WINDOW_COVERING;
    if (accessory.category !== category) {
      accessory.category = category;
      this.api.updatePlatformAccessories([accessory]);
    }
  }

  private registerHandler(accessory: PlatformAccessory<ShadeContext>): void {
    const shadeId = accessory.context.shadeId;
    this.accessories[shadeId] = accessory;

    try {
      const handler = new PowerViewPlatformAccessory(this, accessory, this.log);
      this.handlers.set(shadeId, handler);
    } catch (err) {
      this.handlers.delete(shadeId);
      logError(this.log, `Failed to register shade handler for ${shadeId}:`, err);
    }
  }

  private addShadeAccessory(shade: PowerViewShade): PlatformAccessory<ShadeContext> {
    const name = decodeBase64Name(shade.name, `Shade ${shade.id}`);
    this.log.info('Adding shade %d: %s', shade.id, name);

    const uuid = this.api.hap.uuid.generate(shade.id.toString());
    const accessory = new this.api.platformAccessory<ShadeContext>(
      name,
      uuid,
      this.api.hap.Categories.WINDOW_COVERING,
    );
    accessory.context.shadeId = shade.id;
    accessory.context.shadeType = this.shadeType(shade);
    accessory.context.jogSupported = true;

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
    this.lastPositions.delete(accessory.context.shadeId);
    this.batteryRefreshDisabled.delete(accessory.context.shadeId);
  }

  async updateShades(): Promise<void> {
    let shadeData: PowerViewShade[];
    try {
      shadeData = await this.hub.getShades();
    } catch (err) {
      logError(this.log, 'Failed to list shades from hub:', err);
      return;
    }

    const newShades: Record<number, PlatformAccessory<ShadeContext>> = {};

    for (const shade of shadeData) {
      if (typeof shade.id !== 'number' || !Number.isFinite(shade.id)) {
        this.log.warn('Skipping shade with invalid id from hub response');
        continue;
      }

      try {
        if (!this.accessories[shade.id]) {
          newShades[shade.id] = this.addShadeAccessory(shade);
        } else {
          newShades[shade.id] = this.updateShadeAccessory(shade);
        }

        if (!this.handlers.has(shade.id)) {
          this.registerHandler(newShades[shade.id]);
        }

        const handler = this.handlers.get(shade.id);
        if (handler) {
          handler.updateShadeValues(shade);
          try {
            const shadeState = await this.hub.getShade(shade.id);
            handler.updateShadeValues(shadeState);
          } catch (err) {
            logError(this.log, `Failed to fetch shade ${shade.id} state:`, err);
          }
        }
      } catch (err) {
        logError(this.log, `Failed to process shade ${shade.id}:`, err);
      }
    }

    for (const shadeId of Object.keys(this.accessories)) {
      const id = parseInt(shadeId, 10);
      if (!newShades[id]) {
        this.removeShadeAccessory(this.accessories[id]);
      }
    }
  }

  private pollShades(): void {
    void this.updateShades()
      .catch((err) => {
        logError(this.log, 'Failed to poll shades from hub:', err);
      })
      .finally(() => {
        setTimeout(() => this.pollShades(), SHADE_POLL_INTERVAL_MS);
      });
  }

  private scheduleBatteryPoll(): void {
    if (this.batteryPollTimer) {
      clearInterval(this.batteryPollTimer);
    }
    this.batteryPollTimer = setInterval(() => {
      void this.pollBatteryLevels();
    }, BATTERY_POLL_INTERVAL_MS);
  }

  private async pollBatteryLevels(): Promise<void> {
    for (const shadeId of Object.keys(this.accessories)) {
      const id = parseInt(shadeId, 10);
      if (this.batteryRefreshDisabled.has(id)) {
        continue;
      }
      try {
        const shade = await this.hub.getShade(id, { updateBatteryLevel: true });
        const handler = this.handlers.get(id);
        handler?.updateShadeValues(shade);
      } catch (err) {
        if (isHubError(err) && (err.code === HubErrorCode.NotFound || err.code === HubErrorCode.BadRequest)) {
          this.batteryRefreshDisabled.add(id);
          this.log.debug('Battery refresh not supported for shade %d', id);
        } else {
          this.log.warn('Battery refresh failed for shade %d:', id, err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  async updateHubInfo(): Promise<void> {
    const userData = await this.hub.getUserData();
    this.hubName = decodeBase64Name(userData.hubName, 'PowerView Hub');
    if (userData.firmware?.mainProcessor) {
      this.hubVersion = userData.firmware.mainProcessor.name;
    }

    this.log.info('Hub: %s', this.hubName);

    try {
      this.hubCapabilities = await probeHubCapabilities(this.hub, this.log, this.hubVersion);
      this.log.info(
        'Hub capabilities: fwversion=%s scenes=%s sceneCollections=%s generation=%s',
        this.hubCapabilities.fwVersionSupported,
        this.hubCapabilities.scenesSupported,
        this.hubCapabilities.sceneCollectionsSupported,
        this.hubCapabilities.generationHint,
      );
    } catch (err) {
      logError(this.log, 'Hub capability probe failed (continuing with shades only):', err);
    }

    for (const handler of this.handlers.values()) {
      handler.updateAccessoryInformation();
    }
  }

  private async updateShade(
    shadeId: number,
    refresh = false,
  ): Promise<{ positions: PositionMap | null; timedOut?: boolean }> {
    const shade = await this.hub.getShade(shadeId, { refresh });
    const handler = this.handlers.get(shadeId);
    const positions = handler?.updateShadeValues(shade) ?? null;
    this.cachePositions(shadeId, positions);
    return { positions, timedOut: refresh ? shade.timedOut : undefined };
  }

  async getPosition(
    shadeId: number,
    position: HubPosition,
    callback: CharacteristicCallback,
  ): Promise<void> {
    this.log.debug('getPosition %d/%d', shadeId, position);

    try {
      const value = await this.updatePosition(shadeId, position, this.refreshShades);
      if (!this.refreshShades && value == null) {
        if (this.strictErrors) {
          // Strict mode opts into surfacing hub failures, so keep the blocking refresh.
          this.log.debug('refresh %d/%d', shadeId, position);
          const refreshed = await this.updatePosition(shadeId, position, true);
          callback(null, this.resolvePositionValue(shadeId, position, refreshed));
          return;
        }
        // Answer HomeKit now from cache. A blocking refresh wakes the motor over RF
        // and routinely exceeds HomeKit's read budget, which logged "read handler
        // didn't respond at all" and stalled the accessory. updateShade() pushes the
        // real value via updateCharacteristic as soon as the hub answers.
        this.scheduleBackgroundRefresh(shadeId, position);
        callback(null, this.resolvePositionValue(shadeId, position, null));
      } else {
        callback(null, this.resolvePositionValue(shadeId, position, value));
      }
    } catch (err) {
      if (this.strictErrors) {
        logError(this.log, `getPosition failed for shade ${shadeId}/${position}:`, err);
        callback(err instanceof Error ? err : new Error(formatError(err)));
        return;
      }
      logError(this.log, `getPosition failed for shade ${shadeId}/${position}, using cache:`, err);
      callback(null, this.resolvePositionValue(shadeId, position, null));
    }
  }

  /** Refreshes a shade off the HomeKit read path, deduped per shade. */
  private scheduleBackgroundRefresh(shadeId: number, position: HubPosition): void {
    if (this.pendingRefresh.has(shadeId)) {
      return;
    }
    this.pendingRefresh.add(shadeId);
    void (async () => {
      try {
        this.log.debug('background refresh %d/%d', shadeId, position);
        await this.updatePosition(shadeId, position, true);
      } catch (err) {
        logError(this.log, `Background refresh failed for shade ${shadeId}:`, err);
      } finally {
        this.pendingRefresh.delete(shadeId);
      }
    })();
  }

  private resolvePositionValue(
    shadeId: number,
    position: HubPosition,
    value: number | null | undefined,
  ): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    const cached = this.getCachedPosition(shadeId, position);
    if (cached != null) {
      return cached;
    }
    return 0;
  }

  private async updatePosition(
    shadeId: number,
    position: HubPosition,
    refresh: boolean,
  ): Promise<number | null> {
    const { positions, timedOut } = await this.updateShade(shadeId, refresh);

    if (refresh && timedOut) {
      this.log.warn('Shade %d did not respond to refresh; using cached position for %d', shadeId, position);
      if (this.strictErrors) {
        throw new HubError('Shade refresh timed out', HubErrorCode.HttpError);
      }
      return this.getCachedPosition(shadeId, position) ?? null;
    }

    if (!positions) {
      this.log.warn('Hub did not return positions for %d/%d', shadeId, position);
      return this.getCachedPosition(shadeId, position) ?? null;
    }

    const value = positions[position];
    if (typeof value === 'number' && Number.isFinite(value)) {
      this.log.debug('updatePosition %d/%d: %d', shadeId, position, value);
      return value;
    }

    this.log.warn('Invalid position value received for %d/%d', shadeId, position);
    return this.getCachedPosition(shadeId, position) ?? null;
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
      const positions = handler?.updateShadeValues(shade, true) ?? null;
      this.cachePositions(shadeId, positions);
      callback(null);
    } catch (err) {
      logError(this.log, `setPosition failed for shade ${shadeId}/${position}:`, err);
      callback(err instanceof Error ? err : new Error(formatError(err)));
    }
  }

  async jogShade(shadeId: number): Promise<Partial<Record<HubPosition, number>> | null> {
    const accessory = this.accessories[shadeId];
    if (accessory?.context.jogSupported === false) {
      return null;
    }

    try {
      const shade = await this.hub.jogShade(shadeId);
      const handler = this.handlers.get(shadeId);
      const positions = handler?.updateShadeValues(shade) ?? null;
      this.cachePositions(shadeId, positions);
      return positions;
    } catch (err) {
      if (
        isHubError(err)
        && (err.code === HubErrorCode.NotFound || err.code === HubErrorCode.BadRequest)
      ) {
        if (accessory) {
          accessory.context.jogSupported = false;
        }
        this.log.warn('Jog motion not supported for shade %d', shadeId);
        return null;
      }
      throw err;
    }
  }

  async jogShadeOnIdentify(shadeId: number): Promise<void> {
    try {
      await this.jogShade(shadeId);
    } catch (err) {
      logError(this.log, `Identify/jog failed for shade ${shadeId}:`, err);
    }
  }

  warnPositionKindErrorOnce(shadeId: number): void {
    if (this.posKindErrorLogged.has(shadeId)) {
      return;
    }
    this.posKindErrorLogged.add(shadeId);
    this.log.warn('Shade %d reported position kind error (%d) from hub', shadeId, POSITION_KIND_ERROR);
  }
}
