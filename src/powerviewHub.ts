import type { Logging } from 'homebridge';

import { HubError, HubErrorCode, formatError, logError } from './errors.js';
import { parsePositionMap, serializePositionMap } from './shadeUtils.js';

const INITIAL_REQUEST_DELAY_MS = 100;
const REQUEST_INTERVAL_MS = 100;
const MAINTENANCE_RETRY_ATTEMPTS = 3;
const MAINTENANCE_RETRY_DELAY_MS = 2000;
/**
 * Hard ceiling on any single hub request. Node's fetch has no default timeout, and
 * the hub serialises every call through one queue — a half-open socket would stall
 * every subsequent request forever.
 */
const REQUEST_TIMEOUT_MS = 15000;

export enum HubPosition {
  BOTTOM = 1,
  TOP = 2,
  VANES = 3,
}

export interface ShadePositions {
  [key: string]: number;
}

export interface ShadeFirmware {
  revision: number;
  subRevision: number;
  build: number;
  index?: number;
}

export interface PowerViewShade {
  id: number;
  name: string;
  type?: number;
  positions?: ShadePositions;
  timedOut?: boolean;
  batteryStatus?: number;
  batteryStrength?: number;
  firmware?: ShadeFirmware;
  roomId?: number;
  groupId?: number;
  secondaryName?: string;
}

interface QueuedRequest {
  shadeId: number;
  data?: {
    positions?: ShadePositions;
    motion?: string;
  };
  qs?: Record<string, string>;
  callbacks: Array<(err: Error | null, shade?: PowerViewShade) => void>;
}

export interface HubFirmware {
  mainProcessor?: {
    name: string;
    build?: number;
    revision?: number;
    subRevision?: number;
  };
  radio?: {
    build?: number;
    revision?: number;
    subRevision?: number;
  };
}

export interface HubUserData {
  hubName: string;
  serialNumber: string;
  rfStatus?: number;
  firmware?: HubFirmware;
}

export interface HubResponse<T> {
  ok: boolean;
  status: number;
  data?: T;
  userData?: HubUserData;
}

/**
 * Settles a shade promise from the queue's callback signature. Every queued
 * shade request resolves the same three ways, and the shape was repeated at
 * each of the six call sites.
 */
function settleShade(
  resolve: (shade: PowerViewShade) => void,
  reject: (err: Error) => void,
): (err: Error | null, shade?: PowerViewShade) => void {
  return (err, shade) => {
    if (err) {
      reject(err);
    } else if (shade) {
      resolve(shade);
    } else {
      reject(new HubError('No shade data returned', HubErrorCode.EmptyBody));
    }
  };
}

export class PowerViewHub {
  private readonly queue: QueuedRequest[] = [];

  /**
   * Serialises every HTTP call to the hub. Legacy PowerView hubs are small
   * embedded devices that answer one request at a time; concurrent calls make
   * them time out or return truncated JSON mid-response. The shade queue only
   * ordered shade requests — capability probes and /api/shades listings called
   * fetchJson directly and raced against it.
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly log: Logging,
    private readonly host: string,
  ) {}

  private baseUrl(path: string): string {
    return `http://${this.host}${path}`;
  }

  /** Runs `fn` after all previously serialised work, spaced by REQUEST_INTERVAL_MS. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      try {
        return await fn();
      } finally {
        await this.delay(REQUEST_INTERVAL_MS);
      }
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private extractUserData(body: unknown): HubUserData | undefined {
    if (body && typeof body === 'object' && 'userData' in body) {
      const userData = (body as { userData?: HubUserData }).userData;
      if (userData && typeof userData.hubName === 'string') {
        return userData;
      }
    }
    return undefined;
  }

  private hubErrorForStatus(
    status: number,
    url: string,
    userData?: HubUserData,
  ): HubError {
    switch (status) {
    case 400:
      return new HubError(`Bad request for ${url}`, HubErrorCode.BadRequest, status, userData);
    case 404:
      return new HubError(`Not found: ${url}`, HubErrorCode.NotFound, status, userData);
    case 423:
      return new HubError(
        `Hub is busy or in maintenance (${url})`,
        HubErrorCode.Maintenance,
        status,
        userData,
      );
    default:
      return new HubError(`HTTP ${status} for ${url}`, HubErrorCode.HttpError, status, userData);
    }
  }

  async requestJson<T>(
    url: string,
    init?: RequestInit,
    options?: { retriesOnMaintenance?: boolean },
  ): Promise<HubResponse<T>> {
    const retries = options?.retriesOnMaintenance !== false
      ? MAINTENANCE_RETRY_ATTEMPTS
      : 1;

    let lastError: HubError | undefined;

    for (let attempt = 0; attempt < retries; ++attempt) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const { response, body } = await this.serialize(async () => {
          // Start the timeout when the request actually begins, not while queued.
          timer = setTimeout(() => {
            controller.abort();
          }, REQUEST_TIMEOUT_MS);
          const res = await fetch(url, { ...init, signal: controller.signal });

          // The body is read inside the serialised section on purpose. fetch()
          // settles as soon as headers arrive, so returning here would stream
          // the body concurrently with the next request's fetch — which is the
          // overlap that makes the hub time out and truncate its JSON.
          const contentType = res.headers.get('content-type') ?? '';
          const parsed: unknown = contentType.includes('application/json')
            ? await res.json()
            : undefined;
          return { response: res, body: parsed };
        });

        const userData = this.extractUserData(body);

        if (response.status === 423) {
          const err = this.hubErrorForStatus(423, url, userData);
          if (userData?.rfStatus === 1) {
            this.log.warn('Hub RF network is busy (discovering or joining)');
          }
          lastError = err;
          if (attempt < retries - 1) {
            this.log.warn(
              'Hub busy (HTTP 423), retrying in %dms (attempt %d/%d)',
              MAINTENANCE_RETRY_DELAY_MS,
              attempt + 1,
              retries,
            );
            await this.delay(MAINTENANCE_RETRY_DELAY_MS);
            continue;
          }
          throw err;
        }

        if (!response.ok) {
          throw this.hubErrorForStatus(response.status, url, userData);
        }

        return {
          ok: true,
          status: response.status,
          data: body as T,
          userData,
        };
      } catch (err) {
        if (err instanceof HubError) {
          if (err.code === HubErrorCode.Maintenance && attempt < retries - 1) {
            lastError = err;
            await this.delay(MAINTENANCE_RETRY_DELAY_MS);
            continue;
          }
          throw err;
        }
        if (controller.signal.aborted) {
          throw new HubError(
            `Timed out after ${REQUEST_TIMEOUT_MS}ms waiting for PowerView hub at ${this.host} (${url})`,
            HubErrorCode.Timeout,
            undefined,
            undefined,
            { cause: err },
          );
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw new HubError(
          `Failed to reach PowerView hub at ${this.host} (${url}): ${detail}`,
          HubErrorCode.Unreachable,
          undefined,
          undefined,
          { cause: err },
        );
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    }

    throw lastError ?? new HubError(`Request failed for ${url}`, HubErrorCode.HttpError);
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.requestJson<T>(url, init);
    if (!response.data) {
      throw new HubError(`Empty response body for ${url}`, HubErrorCode.EmptyBody);
    }
    return response.data;
  }

  /** Returns true if the endpoint exists (HTTP 200), false if 404. */
  async probeEndpoint(path: string): Promise<boolean> {
    try {
      await this.requestJson(this.baseUrl(path), undefined, { retriesOnMaintenance: false });
      return true;
    } catch (err) {
      if (err instanceof HubError && err.code === HubErrorCode.NotFound) {
        return false;
      }
      throw err;
    }
  }

  private queueRequest(queued: QueuedRequest): void {
    if (!this.queue.length) {
      this.scheduleRequest(INITIAL_REQUEST_DELAY_MS);
    }
    this.queue.push(queued);
  }

  private scheduleRequest(delay: number): void {
    setTimeout(() => {
      void this.processQueue().catch((err) => {
        logError(this.log, 'Failed to process hub request queue:', err);
      });
    }, delay);
  }

  private async processQueue(): Promise<void> {
    const queued = this.queue[0];
    if (!queued) {
      return;
    }

    try {
      const url = new URL(this.baseUrl(`/api/shades/${queued.shadeId}`));
      if (queued.qs) {
        for (const [key, value] of Object.entries(queued.qs)) {
          url.searchParams.set(key, value);
        }
      }

      let init: RequestInit | undefined;
      if (queued.data) {
        init = {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shade: queued.data }),
        };
        this.log.debug('Put for %d %s', queued.shadeId, JSON.stringify(queued.data));
      }

      const json = await this.fetchJson<{ shade: PowerViewShade }>(url.toString(), init);
      for (const callback of queued.callbacks) {
        callback(null, json.shade);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(formatError(err));
      logError(this.log, `Error on shade request for shade ${queued.shadeId}:`, error);
      for (const callback of queued.callbacks) {
        callback(error);
      }
    } finally {
      // Must always advance, or one failure wedges the queue and every pending
      // HomeKit request hangs unresolved until Homebridge restarts.
      this.queue.shift();
      if (this.queue.length > 0) {
        this.scheduleRequest(0);
      }
    }
  }

  async getUserData(): Promise<HubUserData> {
    const json = await this.fetchJson<{ userData?: HubUserData }>(this.baseUrl('/api/userdata'));
    if (!json.userData) {
      throw new HubError('Hub returned no userData from /api/userdata', HubErrorCode.EmptyBody);
    }
    return json.userData;
  }

  async getFirmwareVersion(): Promise<HubFirmware> {
    const json = await this.fetchJson<{ firmware?: HubFirmware }>(this.baseUrl('/api/fwversion'));
    if (!json.firmware) {
      throw new HubError('Hub returned no firmware from /api/fwversion', HubErrorCode.EmptyBody);
    }
    return json.firmware;
  }

  async getScenes(): Promise<{ sceneIds: number[]; sceneData: unknown[] }> {
    const json = await this.fetchJson<{
      sceneIds?: number[];
      sceneData?: unknown[];
    }>(this.baseUrl('/api/scenes'));
    return {
      sceneIds: json.sceneIds ?? [],
      sceneData: json.sceneData ?? [],
    };
  }

  async getSceneCollections(): Promise<{
    sceneCollectionIds: number[];
    sceneCollectionData: unknown[];
  }> {
    const json = await this.fetchJson<{
      sceneCollectionIds?: number[];
      sceneCollectionData?: unknown[];
    }>(this.baseUrl('/api/scenecollections'));
    return {
      sceneCollectionIds: json.sceneCollectionIds ?? [],
      sceneCollectionData: json.sceneCollectionData ?? [],
    };
  }

  async getShades(): Promise<PowerViewShade[]> {
    const json = await this.fetchJson<{ shadeData?: PowerViewShade[] }>(this.baseUrl('/api/shades'));
    if (!Array.isArray(json.shadeData)) {
      throw new HubError('Hub returned no shadeData from /api/shades', HubErrorCode.EmptyBody);
    }
    return json.shadeData;
  }

  async getShade(
    shadeId: number,
    options?: { refresh?: boolean; updateBatteryLevel?: boolean },
  ): Promise<PowerViewShade> {
    const refresh = options?.refresh === true;
    const updateBatteryLevel = options?.updateBatteryLevel === true;

    if (refresh && updateBatteryLevel) {
      throw new HubError(
        'Cannot combine refresh and updateBatteryLevel in one hub request',
        HubErrorCode.BadRequest,
      );
    }

    if (refresh) {
      return this.getShadeQueued(shadeId, { refresh: 'true' });
    }

    if (updateBatteryLevel) {
      return this.getShadeQueued(shadeId, { updateBatteryLevel: 'true' });
    }

    const json = await this.fetchJson<{ shade?: PowerViewShade }>(
      this.baseUrl(`/api/shades/${shadeId}`),
    );
    if (!json.shade) {
      throw new HubError(`Hub returned no shade data for shade ${shadeId}`, HubErrorCode.EmptyBody);
    }
    return json.shade;
  }

  private getShadeQueued(
    shadeId: number,
    qs: Record<string, string>,
  ): Promise<PowerViewShade> {
    return new Promise((resolve, reject) => {
      for (const queued of this.queue) {
        if (queued.shadeId === shadeId && queued.qs) {
          const sameQs = Object.keys(qs).every((k) => queued.qs?.[k] === qs[k]);
          if (sameQs) {
            queued.callbacks.push(settleShade(resolve, reject));
            return;
          }
        }
      }

      this.queueRequest({
        shadeId,
        qs,
        callbacks: [settleShade(resolve, reject)],
      });
    });
  }

  async putShade(
    shadeId: number,
    position: HubPosition,
    value: number,
    userValue: number,
  ): Promise<PowerViewShade> {
    return new Promise((resolve, reject) => {
      for (const queued of this.queue) {
        if (queued.shadeId === shadeId && queued.data?.positions) {
          const positions = parsePositionMap(queued.data.positions);

          positions[position] = value;

          if (position === HubPosition.VANES && userValue) {
            delete positions[HubPosition.BOTTOM];
          } else if (position === HubPosition.VANES && positions[HubPosition.BOTTOM] != null) {
            delete positions[HubPosition.VANES];
          } else if (position === HubPosition.BOTTOM && userValue) {
            delete positions[HubPosition.VANES];
          } else if (position === HubPosition.BOTTOM && positions[HubPosition.VANES] != null) {
            delete positions[HubPosition.BOTTOM];
          }

          queued.data.positions = serializePositionMap(positions as Record<number, number>);

          queued.callbacks.push(settleShade(resolve, reject));
          return;
        }
      }

      this.queueRequest({
        shadeId,
        data: {
          positions: serializePositionMap({ [position]: value }),
        },
        callbacks: [settleShade(resolve, reject)],
      });
    });
  }

  /** Halts a shade mid-travel (HomeKit HoldPosition). */
  async stopShade(shadeId: number): Promise<PowerViewShade> {
    return this.motionRequest(shadeId, 'stop');
  }

  async jogShade(shadeId: number): Promise<PowerViewShade> {
    return this.motionRequest(shadeId, 'jog');
  }

  private async motionRequest(shadeId: number, motion: string): Promise<PowerViewShade> {
    return new Promise((resolve, reject) => {
      for (const queued of this.queue) {
        if (queued.shadeId === shadeId && queued.data?.motion === motion) {
          queued.callbacks.push(settleShade(resolve, reject));
          return;
        }
      }

      this.queueRequest({
        shadeId,
        data: { motion },
        callbacks: [settleShade(resolve, reject)],
      });
    });
  }
}
