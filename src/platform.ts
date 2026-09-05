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
  type PowerViewScene,
  type PowerViewSceneMember,
  type PowerViewShade,
} from './powerviewHub.js';
import {
  PowerViewPlatformAccessory,
  type CharacteristicCallback,
} from './platformAccessory.js';
import {
  POSITION_KIND_ERROR,
  type BatteryPollSettings,
  type PositionMap,
  type QuietHours,
  decodeBase64Name,
  isWithinQuietHours,
  lookupPosition,
  msUntilNextDailyRun,
  positionMapsEqual,
  resolveBatteryPollSettings,
  resolveHubHost,
  resolveQuietHours,
  resolveShadeCapability,
  shadeKindForCapability,
  sanitizePositionMap,
} from './shadeUtils.js';
import {
  PLUGIN_NAME,
  PLATFORM_NAME,
  SHADE_POLL_INTERVAL_MS,
  SHADE_REMOVAL_THRESHOLD,
  BACKGROUND_REFRESH_INTERVAL_MS,
  SHADE_FULL_TRAVEL_MS,
  SHADE_MIN_TRAVEL_MS,
  FULLY_SUPPORTED_KINDS,
  ShadeKind,
  SUBTYPE,
  type PowerViewPlatformConfig,
  type SceneContext,
  type ShadeContext,
} from './settings.js';

function shadeIdArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((id): id is number => typeof id === 'number') : [];
}


export class PowerViewPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories = new Map<number, PlatformAccessory<ShadeContext>>();
  private readonly handlers: Map<number, PowerViewPlatformAccessory> = new Map();

  public hubVersion?: string;
  public hubCapabilities?: HubCapabilities;
  private hubName?: string;

  private readonly hub: PowerViewHub;
  private readonly batteryPoll: BatteryPollSettings;
  private readonly quietHours: QuietHours;
  private readonly syncPositionsOnStart: boolean;
  private readonly exposeScenes: boolean;
  private readonly reportTravel: boolean;
  private readonly refreshShades: boolean;
  private readonly pollShadesForUpdate: boolean;
  private readonly strictErrors: boolean;
  private readonly forceRollerShades: number[];
  private readonly forceTopBottomShades: number[];
  private readonly forceHorizontalShades: number[];
  private readonly forceVerticalShades: number[];

  private readonly lastPositions = new Map<number, PositionMap>();
  /** Consecutive shade lists a known shade has been missing from. */
  private readonly missingFromList = new Map<number, number>();
  private readonly positionsOmittedLogged = new Set<number>();
  private readonly unsupportedCapabilityLogged = new Set<number>();

  /** Shades with a background refresh already in flight, so reads don't pile up. */
  private readonly pendingRefresh = new Set<number>();
  /** When each shade last had a background read, so bursts don't stack up. */
  private readonly lastBackgroundRefresh = new Map<number, number>();
  /** Travel timers per shade/position, so a re-target cancels the old arrival. */
  private readonly travelTimers = new Map<string, ReturnType<typeof setTimeout>>();
  public readonly sceneAccessories = new Map<number, PlatformAccessory<SceneContext>>();
  private readonly batteryRefreshDisabled = new Set<number>();
  private readonly posKindErrorLogged = new Set<number>();
  private batteryPollTimer?: ReturnType<typeof setTimeout>;
  private shadePollTimer?: ReturnType<typeof setTimeout>;
  private shuttingDown = false;

  constructor(
    public readonly log: Logging,
    config: PowerViewPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('PowerView init');

    registerProcessErrorHandlers(this.log, PLUGIN_NAME);

    const host = resolveHubHost(config.host, 'powerview-hub.local');
    if (config.host && host !== config.host) {
      this.log.warn(
        'Ignoring configured host %j: it is not a plain hostname or IP address. Using %s.',
        config.host, host,
      );
    }
    const requestIntervalMs = typeof config.requestIntervalMs === 'number'
      && Number.isFinite(config.requestIntervalMs)
      && config.requestIntervalMs >= 0
      ? config.requestIntervalMs
      : undefined;
    this.hub = new PowerViewHub(log, host, requestIntervalMs);

    this.batteryPoll = resolveBatteryPollSettings(config);
    this.quietHours = resolveQuietHours(config);
    this.syncPositionsOnStart = config.syncPositionsOnStart !== false;
    this.exposeScenes = config.exposeScenes !== false;
    this.reportTravel = config.reportTravel === true;
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

    this.api.on('shutdown', () => {
      // The flag matters as much as the timers: updateShades() may be in
      // flight, and its finally block would otherwise schedule the next poll
      // after shutdown has already cleared the handle.
      this.shuttingDown = true;
      if (this.batteryPollTimer) {
        clearTimeout(this.batteryPollTimer);
        this.batteryPollTimer = undefined;
      }
      if (this.shadePollTimer) {
        clearTimeout(this.shadePollTimer);
        this.shadePollTimer = undefined;
      }
      for (const timer of this.travelTimers.values()) {
        clearTimeout(timer);
      }
      this.travelTimers.clear();
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
      await this.updateScenes();
      this.scheduleBatteryPoll();

      // Deliberately not awaited. The sync does an RF read per shade the hub has
      // no position for — seconds each, five motors on a cold cache — and
      // Homebridge should not sit unlaunched through it.
      void this.syncPositionsAtStartup().catch((err) => {
        logError(this.log, 'Startup position sync failed:', err);
      });
    } catch (err) {
      logError(this.log, 'Failed to start PowerView platform:', err);
    }
  }

  cachePositions(shadeId: number, positions: PositionMap | null): void {
    if (!positions) {
      return;
    }
    const existing = this.lastPositions.get(shadeId) ?? {};
    const merged = { ...existing, ...positions };
    this.lastPositions.set(shadeId, merged);

    // Persisted so a restart answers HomeKit with the last known position rather
    // than resolvePositionValue()'s 0, which reads as "fully closed" until the
    // background refresh lands — and sticks if that refresh times out.
    //
    // Mutating context alone does not write cachedAccessories to disk;
    // updatePlatformAccessories() is what schedules the save. Only call it when
    // the map actually changed, so ordinary reads don't rewrite the cache file.
    const accessory = this.accessories.get(shadeId);
    if (accessory && !positionMapsEqual(accessory.context.lastPositions, merged)) {
      accessory.context.lastPositions = merged;
      this.api.updatePlatformAccessories([accessory]);
    }
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

    const capability = resolveShadeCapability(shade);
    if (capability === undefined) {
      this.log.warn(
        'Shade %d has undocumented type %s; treating as roller. '
        + 'Override with forceRollerShades / forceTopBottomShades / '
        + 'forceHorizontalShades / forceVerticalShades if that is wrong.',
        shade.id,
        String(shade.type ?? 'none'),
      );
      return ShadeKind.ROLLER;
    }

    const kind = shadeKindForCapability(capability) ?? ShadeKind.ROLLER;

    if (!FULLY_SUPPORTED_KINDS.includes(kind)) {
      // Say so rather than silently driving it as a roller: capability 6 runs
      // its primary rail reversed, 2 and 5 tilt through 180 rather than 90,
      // and 8/9 have overlapped panels. Positions will be wrong for these.
      this.warnUnsupportedCapabilityOnce(shade.id, capability, kind);
    }

    return kind;
  }

  private warnUnsupportedCapabilityOnce(
    shadeId: number,
    capability: number,
    kind: ShadeKind,
  ): void {
    if (this.unsupportedCapabilityLogged.has(shadeId)) {
      return;
    }
    this.unsupportedCapabilityLogged.add(shadeId);
    this.log.warn(
      'Shade %d is capability %d (%s), which this plugin does not fully implement. '
      + 'Its reported position or tilt may be wrong. Logged once per shade.',
      shadeId,
      capability,
      ShadeKind[kind],
    );
  }

  configureAccessory(accessory: PlatformAccessory): void {
    try {
      const sceneId = (accessory.context as Partial<SceneContext>).sceneId;
      if (typeof sceneId === 'number' && Number.isFinite(sceneId)) {
        const sceneAccessory = accessory as PlatformAccessory<SceneContext>;
        this.log.info('Cached scene %d: %s', sceneId, sceneAccessory.displayName);
        this.wireSceneSwitch(sceneAccessory);
        this.sceneAccessories.set(sceneId, sceneAccessory);
        return;
      }

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

      const restored = sanitizePositionMap(shadeAccessory.context.lastPositions);
      if (Object.keys(restored).length > 0) {
        this.lastPositions.set(shadeId, restored);
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
    this.accessories.set(shadeId, accessory);

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

  private updateShadeAccessory(
    shade: PowerViewShade,
    accessory: PlatformAccessory<ShadeContext>,
  ): PlatformAccessory<ShadeContext> {
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
    this.accessories.delete(accessory.context.shadeId);
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
        const existing = this.accessories.get(shade.id);
        newShades[shade.id] = existing
          ? this.updateShadeAccessory(shade, existing)
          : this.addShadeAccessory(shade);

        if (!this.handlers.has(shade.id)) {
          this.registerHandler(newShades[shade.id]);
        }

        const handler = this.handlers.get(shade.id);
        if (handler) {
          handler.updateShadeValues(shade);

          // Only when the list entry carried nothing to work with. /api/shades
          // already returns positions on hubs that report them, and every hub
          // call is serialised — so refetching each shade doubled the requests
          // per poll cycle for no new information.
          if (!shade.positions) {
            try {
              const shadeState = await this.hub.getShade(shade.id);
              handler.updateShadeValues(shadeState);
            } catch (err) {
              logError(this.log, `Failed to fetch shade ${shade.id} state:`, err);
            }
          }
        }
      } catch (err) {
        logError(this.log, `Failed to process shade ${shade.id}:`, err);
      }
    }

    // Unregistering an accessory is destructive — HomeKit loses its room,
    // its name and any automations referencing it, and none of that comes back
    // when the shade reappears. A hub under load can answer with a short list,
    // which once cost three of five shades. So a shade has to be missing from
    // several consecutive lists before it is treated as genuinely gone, and an
    // empty list is never evidence of anything.
    if (shadeData.length === 0) {
      this.log.debug('Hub returned no shades; keeping all %d accessories', this.accessories.size);
      return;
    }

    for (const [id, accessory] of [...this.accessories]) {
      if (newShades[id]) {
        this.missingFromList.delete(id);
        continue;
      }

      const misses = (this.missingFromList.get(id) ?? 0) + 1;
      this.missingFromList.set(id, misses);

      if (misses < SHADE_REMOVAL_THRESHOLD) {
        this.log.warn(
          'Shade %d (%s) missing from the hub list (%d/%d). Keeping it: a partial '
          + 'response would otherwise destroy the accessory.',
          id, accessory.displayName, misses, SHADE_REMOVAL_THRESHOLD,
        );
        continue;
      }

      this.missingFromList.delete(id);
      this.removeShadeAccessory(accessory);
    }
  }

  private pollShades(): void {
    if (this.shuttingDown) {
      return;
    }
    void this.updateShades()
      .catch((err) => {
        logError(this.log, 'Failed to poll shades from hub:', err);
      })
      .finally(() => {
        if (this.shuttingDown) {
          return;
        }
        this.shadePollTimer = setTimeout(() => this.pollShades(), SHADE_POLL_INTERVAL_MS);
      });
  }

  /**
   * Re-reads positions once at startup for shades the hub has no position for.
   *
   * The hub only holds a position for a while after a set or refresh, and a
   * shade moved by remote is never reported at all — so without this, a
   * restored cache would be served to HomeKit indefinitely with nothing ever
   * correcting it. Startup is the one moment where an RF wake per shade buys
   * accuracy without recurring cost; quiet hours guard the unattended restart.
   */
  private async syncPositionsAtStartup(): Promise<void> {
    if (!this.syncPositionsOnStart) {
      this.log.info('Startup position sync: disabled');
      return;
    }

    const { startHour, endHour } = this.quietHours;
    if (isWithinQuietHours(new Date(), startHour, endHour)) {
      this.log.info('Startup position sync: skipped, quiet hours');
      return;
    }

    let refreshed = 0;
    for (const id of [...this.accessories.keys()]) {
      if (this.shuttingDown) {
        this.log.debug('Startup position sync abandoned: shutting down');
        return;
      }
      try {
        const { positions } = await this.updateShade(id);
        if (positions && Object.keys(positions).length > 0) {
          continue;
        }
        await this.updateShade(id, true);
        refreshed++;
      } catch (err) {
        logError(this.log, `Startup position sync failed for shade ${id}:`, err);
      }
    }

    this.log.info('Startup position sync: refreshed %d shade(s) over RF', refreshed);
  }

  async stopShade(shadeId: number): Promise<void> {
    this.log.info('stopShade %d', shadeId);
    const shade = await this.hub.stopShade(shadeId);
    const handler = this.handlers.get(shadeId);
    this.cachePositions(shadeId, handler?.updateShadeValues(shade) ?? null);
  }

  private scheduleBatteryPoll(): void {
    if (this.batteryPollTimer) {
      clearTimeout(this.batteryPollTimer);
      this.batteryPollTimer = undefined;
    }

    if (!this.batteryPoll.enabled) {
      this.log.info('Battery poll: disabled');
      return;
    }

    const { hour, minute } = this.batteryPoll.at;
    // Recomputed from `now` after every run, never by adding 24h, so the poll
    // stays pinned to the same wall-clock time across DST changes.
    const delay = msUntilNextDailyRun(new Date(), hour, minute);

    this.log.info(
      'Battery poll: next run %02d:%02d local, in %dh%02dm',
      hour,
      minute,
      Math.floor(delay / (60 * 60 * 1000)),
      Math.floor((delay % (60 * 60 * 1000)) / (60 * 1000)),
    );

    this.batteryPollTimer = setTimeout(() => {
      void this.pollBatteryLevels().finally(() => {
        this.scheduleBatteryPoll();
      });
    }, delay);
  }

  private async pollBatteryLevels(): Promise<void> {
    // Logged at info deliberately: this moves physical hardware, so it must be
    // attributable from the default log without enabling debug.
    this.log.info('Battery poll: refreshing %d shades', this.accessories.size);

    for (const id of [...this.accessories.keys()]) {
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

    // Answer from cache without awaiting the hub at all. Even a cached hub read
    // is a serialised round-trip, and HomeKit reads every characteristic of
    // every shade at once — the later ones then exceed its read budget and log
    // "read handler was slow to respond". The cache survives restarts, so it is
    // warm from the first read. refreshShades and strictErrors both opt into
    // hitting the hub, so they keep the blocking path.
    if (!this.refreshShades && !this.strictErrors) {
      const cached = this.getCachedPosition(shadeId, position);
      if (cached != null) {
        // Answer first. scheduleBackgroundRefresh runs synchronously up to its
        // first await, so scheduling ahead of the callback puts a fetch on the
        // stack before HomeKit has its value.
        callback(null, cached);
        this.scheduleBackgroundRefresh(shadeId, position);
        return;
      }
    }

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
        this.scheduleBackgroundRefresh(shadeId, position, true);
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

  /**
   * Refreshes a shade off the HomeKit read path, deduped per shade and rate
   * limited per shade.
   *
   * `refresh` is the expensive kind: it wakes the motor over RF, takes seconds,
   * and is what used to move shades at 05:54. It is only justified when the hub
   * has no position at all. Servicing an ordinary read uses the cheap cached
   * read, which never touches the radio.
   */
  private scheduleBackgroundRefresh(
    shadeId: number,
    position: HubPosition,
    refresh = false,
  ): void {
    if (this.pendingRefresh.has(shadeId)) {
      return;
    }

    const last = this.lastBackgroundRefresh.get(shadeId) ?? 0;
    if (!refresh && Date.now() - last < BACKGROUND_REFRESH_INTERVAL_MS) {
      return;
    }

    this.pendingRefresh.add(shadeId);
    this.lastBackgroundRefresh.set(shadeId, Date.now());
    void (async () => {
      try {
        this.log.debug('background refresh %d/%d (rf=%s)', shadeId, position, refresh);
        await this.updatePosition(shadeId, position, refresh);
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

    const lookup = lookupPosition(positions, position);
    if (lookup.kind === 'ok') {
      this.log.debug('updatePosition %d/%d: %d', shadeId, position, lookup.value);
      return lookup.value;
    }

    if (lookup.kind === 'invalid') {
      this.log.warn(
        'Invalid position value for %d/%d: %s',
        shadeId, position, String(lookup.value),
      );
    } else {
      // Normal on a Gen 2 hub: a cached read carries no `positions` at all, so
      // the value arrives later via background refresh. Not an error.
      this.log.debug('Hub omitted position %d/%d; answering from cache', shadeId, position);
      this.notePositionsOmittedOnce(shadeId);
    }

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
      const accessory = this.accessories.get(shadeId);
      if (!accessory) {
        // A set can still arrive for an accessory Homebridge removed between
        // HomeKit's read and its write. Without this the throw escapes the
        // handler as an unhandled rejection, since it precedes the try below.
        callback(new Error(`Unknown shade: ${shadeId}`));
        return;
      }
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
      const handler = this.handlers.get(shadeId);
      const from = this.getCachedPosition(shadeId, position) ?? 0;

      const shade = await this.hub.putShade(shadeId, position, hubValue, value);

      if (this.reportTravel) {
        // Truer: the hub's PUT reply only echoes the target, so feeding it into
        // CurrentPosition claims arrival while the motor is still running.
        handler?.reportMovement(position, from, value);
        this.scheduleArrival(shadeId, position, from, value);
      } else {
        // Default: report the commanded position at once, so the tile responds
        // when tapped. It is ahead of the shade for the length of the travel,
        // and a move that never physically happens goes unnoticed until
        // something refreshes that shade.
        const positions = handler?.updateShadeValues(shade, true) ?? null;
        this.cachePositions(shadeId, positions);
      }
      callback(null);
    } catch (err) {
      logError(this.log, `setPosition failed for shade ${shadeId}/${position}:`, err);
      callback(err instanceof Error ? err : new Error(formatError(err)));
    }
  }

  /**
   * Publishes one stateless switch per hub scene.
   *
   * A scene is the only way to move a group together: it is a single call the
   * hub expands itself, so every motor gets its RF command at once. Driving the
   * same shades individually costs one serialised write each and they visibly
   * stagger.
   */
  async updateScenes(): Promise<void> {
    if (!this.exposeScenes) {
      return;
    }

    let scenes: PowerViewScene[];
    try {
      scenes = (await this.hub.getScenes()).sceneData;
    } catch (err) {
      logError(this.log, 'Failed to list scenes from hub:', err);
      return;
    }

    const seen = new Set<number>();
    for (const scene of scenes) {
      if (typeof scene.id !== 'number' || !Number.isFinite(scene.id)) {
        continue;
      }
      seen.add(scene.id);
      if (!this.sceneAccessories.has(scene.id)) {
        this.addSceneAccessory(scene);
      }
    }

    // Same reasoning as shades: an empty or short list is not evidence a scene
    // was deleted, and unregistering is irreversible for the user.
    if (scenes.length === 0) {
      return;
    }
    for (const [id, accessory] of [...this.sceneAccessories]) {
      if (!seen.has(id)) {
        this.log.info('Removing scene %d: %s', id, accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.sceneAccessories.delete(id);
      }
    }
  }

  /**
   * Brings HomeKit up to date after a scene runs.
   *
   * The hub expands the scene itself and its reply names no shades, so without
   * this the Home app showed stale positions until something else happened to
   * refresh each shade. The scene's membership carries the target positions, so
   * this costs one cheap request and no RF wake.
   */
  private async applyScenePositions(sceneId: number): Promise<void> {
    let members: PowerViewSceneMember[];
    try {
      members = await this.hub.getSceneMembers(sceneId);
    } catch (err) {
      logError(this.log, `Could not read members of scene ${sceneId}:`, err);
      return;
    }

    for (const member of members) {
      const handler = this.handlers.get(member.shadeId);
      if (!handler || !member.positions) {
        continue;
      }
      const positions = handler.applyHubPositions(member.shadeId, member.positions, true);
      this.cachePositions(member.shadeId, positions);
    }
  }

  private addSceneAccessory(scene: PowerViewScene): void {
    const name = decodeBase64Name(scene.name, `Scene ${scene.id}`);
    this.log.info('Adding scene %d: %s', scene.id, name);

    const uuid = this.api.hap.uuid.generate(`scene:${scene.id}`);
    const accessory = new this.api.platformAccessory<SceneContext>(name, uuid);
    accessory.context.sceneId = scene.id;

    this.wireSceneSwitch(accessory);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.sceneAccessories.set(scene.id, accessory);
  }

  private wireSceneSwitch(accessory: PlatformAccessory<SceneContext>): void {
    const sceneId = accessory.context.sceneId;
    const service = accessory.getService(this.Service.Switch)
      ?? accessory.addService(this.Service.Switch, accessory.displayName);

    service
      .getCharacteristic(this.Characteristic.On)
      .removeAllListeners('set')
      .on('set', (value, callback) => {
        if (value !== true) {
          callback(null);
          return;
        }
        void this.hub.activateScene(sceneId)
          .then(async (shadeIds) => {
            if (shadeIds) {
              this.log.info('Scene %d activated (%d shade(s))', sceneId, shadeIds.length);
            } else {
              this.log.info('Scene %d activated', sceneId);
            }
            callback(null);
            await this.applyScenePositions(sceneId);
          })
          .catch((err) => {
            logError(this.log, `Failed to activate scene ${sceneId}:`, err);
            callback(err instanceof Error ? err : new Error(formatError(err)));
          })
          .finally(() => {
            // A scene is a button, not a state. Reset so it can be fired again.
            service.updateCharacteristic(this.Characteristic.On, false);
          });
      });
  }

  /**
   * Marks the shade arrived once its estimated travel has elapsed.
   *
   * Estimated rather than polled: this hub reports no positions on a cached
   * read, so confirming arrival would mean an RF round-trip that wakes the motor
   * again the moment it stopped. The startup sync and any later refresh correct
   * the value if the shade did not make it.
   */
  private scheduleArrival(
    shadeId: number,
    position: HubPosition,
    from: number,
    to: number,
  ): void {
    const key = `${shadeId}:${position}`;
    const existing = this.travelTimers.get(key);
    if (existing) {
      // A re-target mid-travel: the old timer would otherwise land later and
      // park the shade at a position it was already steered away from.
      clearTimeout(existing);
    }

    const distance = Math.abs(to - from);
    const travel = Math.max(
      SHADE_MIN_TRAVEL_MS,
      Math.round(SHADE_FULL_TRAVEL_MS * distance / 100),
    );

    this.travelTimers.set(key, setTimeout(() => {
      this.travelTimers.delete(key);
      if (this.shuttingDown) {
        return;
      }
      this.handlers.get(shadeId)?.reportArrival(position, to);
      this.cachePositions(shadeId, { [position]: to });
    }, travel));
  }

  async jogShade(shadeId: number): Promise<Partial<Record<HubPosition, number>> | null> {
    const accessory = this.accessories.get(shadeId);
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

  private notePositionsOmittedOnce(shadeId: number): void {
    if (this.positionsOmittedLogged.has(shadeId)) {
      return;
    }
    this.positionsOmittedLogged.add(shadeId);
    this.log.info(
      'Shade %d: hub returns no positions on cached reads; position will follow from a background '
      + 'refresh. Logged once per shade.',
      shadeId,
    );
  }

  warnPositionKindErrorOnce(shadeId: number): void {
    if (this.posKindErrorLogged.has(shadeId)) {
      return;
    }
    this.posKindErrorLogged.add(shadeId);
    this.log.warn('Shade %d reported position kind error (%d) from hub', shadeId, POSITION_KIND_ERROR);
  }
}
