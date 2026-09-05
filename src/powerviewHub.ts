import type { Logging } from 'homebridge';

import { HubError, HubErrorCode, formatError, logError } from './errors.js';
import { parsePositionMap, serializePositionMap } from './shadeUtils.js';

/**
 * How long a shade request waits before going out, so several sets for one
 * shade merge into a single PUT. Every ms here is latency on a HomeKit tap.
 */
const INITIAL_REQUEST_DELAY_MS = 100;
/**
 * Spacing between serialised hub requests.
 *
 * Briefly lowered to 25ms on the strength of a read-only probe, then restored:
 * cached reads never engage the hub's radio, but a PUT does, and a gen1 hub
 * drops TCP connections while transmitting. In use that lost two of five shades
 * in a group move. Overridable via `requestIntervalMs` for anyone who wants to
 * retune it against their own hub, with writes included this time.
 */
const DEFAULT_REQUEST_INTERVAL_MS = 100;
const MAINTENANCE_RETRY_ATTEMPTS = 3;
const MAINTENANCE_RETRY_DELAY_MS = 2000;
/**
 * A gen1 hub drops TCP connections while its radio is busy, which surfaces as a
 * bare `fetch failed`. Losing the request means the shade never moves, so a
 * transient network failure is retried rather than reported.
 */
const NETWORK_RETRY_ATTEMPTS = 3;
const NETWORK_RETRY_DELAY_MS = 500;
/**
 * Hard ceiling on any single hub request. Node's fetch has no default timeout, and
 * the hub serialises every call through one queue — a half-open socket would stall
 * every subsequent request forever.
 */
const REQUEST_TIMEOUT_MS = 15000;
/**
 * Most the plugin will buffer from one hub response. A shade list for a large
 * home is a few tens of kilobytes; anything approaching this is a hub fault or
 * something pretending to be a hub. Without a ceiling the body is read straight
 * into memory and can take the whole Homebridge process with it.
 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Lower runs first. HomeKit writes must not wait behind background reads. */
export enum RequestPriority {
  Write = 0,
  Read = 1,
}

export enum HubPosition {
  BOTTOM = 1,
  TOP = 2,
  VANES = 3,
}

export interface PowerViewScene {
  id: number;
  /** Base64, like shade names. */
  name: string;
  roomId?: number;
  order?: number;
}

export interface PowerViewSceneMember {
  id: number;
  sceneId: number;
  shadeId: number;
  positions?: ShadePositions;
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
  private readonly pending: Array<{
    priority: RequestPriority;
    seq: number;
    run: () => Promise<unknown>;
    settle: (value: unknown) => void;
    fail: (err: unknown) => void;
  }> = [];

  private draining = false;
  private seq = 0;
  private readonly requestIntervalMs: number;

  constructor(
    private readonly log: Logging,
    private readonly host: string,
    requestIntervalMs?: number,
  ) {
    this.requestIntervalMs = typeof requestIntervalMs === 'number' && requestIntervalMs >= 0
      ? requestIntervalMs
      : DEFAULT_REQUEST_INTERVAL_MS;
  }

  private baseUrl(path: string): string {
    return `http://${this.host}${path}`;
  }

  /**
   * Runs `fn` once nothing else is in flight, highest priority first and FIFO
   * within a priority. The hub answers one request at a time, so this is the
   * single gate every call passes through.
   */
  private serialize<T>(fn: () => Promise<T>, priority = RequestPriority.Read): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        priority,
        seq: this.seq++,
        run: fn as () => Promise<unknown>,
        settle: resolve as (value: unknown) => void,
        fail: reject,
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        // Re-sorted each pass: a write queued while the previous request was in
        // flight has to be able to overtake reads already waiting.
        this.pending.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
        const task = this.pending.shift();
        if (!task) {
          break;
        }
        try {
          task.settle(await task.run());
        } catch (err) {
          task.fail(err);
        }
        // Only between requests, never after the last one.
        if (this.pending.length > 0) {
          await this.delay(this.requestIntervalMs);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Reads a JSON body with a hard ceiling on how much is buffered.
   *
   * Streamed rather than `res.json()` so an oversized body is abandoned partway
   * instead of being fully materialised first. The request timeout does not help
   * here: it bounds a stalled socket, not a fast enormous one.
   */
  private async readJsonCapped(res: Response, url: string): Promise<unknown> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new HubError(
        `Hub response for ${url} declares ${declared} bytes, over the ${MAX_RESPONSE_BYTES} limit`,
        HubErrorCode.ResponseTooLarge,
      );
    }

    const stream = res.body;
    if (!stream) {
      return undefined;
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new HubError(
            `Hub response for ${url} exceeded ${MAX_RESPONSE_BYTES} bytes`,
            HubErrorCode.ResponseTooLarge,
          );
        }
        chunks.push(value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released by cancel().
      }
    }

    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim().length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      // Distinct from Unreachable: the hub answered, it just answered badly.
      throw new HubError(
        `Hub returned malformed JSON for ${url}`,
        HubErrorCode.MalformedBody,
        undefined,
        undefined,
        { cause: err },
      );
    }
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
    options?: { retriesOnMaintenance?: boolean; priority?: RequestPriority },
  ): Promise<HubResponse<T>> {
    const retries = options?.retriesOnMaintenance !== false
      ? Math.max(MAINTENANCE_RETRY_ATTEMPTS, NETWORK_RETRY_ATTEMPTS)
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
            ? await this.readJsonCapped(res, url)
            : undefined;
          return { response: res, body: parsed };
        }, options?.priority ?? RequestPriority.Read);

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
        const unreachable = new HubError(
          `Failed to reach PowerView hub at ${this.host} (${url}): ${detail}`,
          HubErrorCode.Unreachable,
          undefined,
          undefined,
          { cause: err },
        );
        if (attempt < Math.min(retries, NETWORK_RETRY_ATTEMPTS) - 1) {
          lastError = unreachable;
          this.log.debug(
            'Hub connection dropped (%s), retrying in %dms (attempt %d/%d)',
            detail, NETWORK_RETRY_DELAY_MS, attempt + 1, NETWORK_RETRY_ATTEMPTS,
          );
          await this.delay(NETWORK_RETRY_DELAY_MS);
          continue;
        }
        throw unreachable;
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    }

    throw lastError ?? new HubError(`Request failed for ${url}`, HubErrorCode.HttpError);
  }

  private async fetchJson<T>(
    url: string,
    init?: RequestInit,
    priority?: RequestPriority,
  ): Promise<T> {
    const response = await this.requestJson<T>(url, init, { priority });
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

      const json = await this.fetchJson<{ shade: PowerViewShade }>(
        url.toString(),
        init,
        // A PUT is a HomeKit command; it must not sit behind background reads.
        init ? RequestPriority.Write : RequestPriority.Read,
      );
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

  /** Scenes stored on the hub. `sceneData` is empty when none are defined. */
  async getScenes(): Promise<{ sceneIds: number[]; sceneData: PowerViewScene[] }> {
    const json = await this.fetchJson<{
      sceneIds?: number[];
      sceneData?: PowerViewScene[];
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

  /**
   * Activates a scene and returns the shades it moved.
   *
   * This is one call the hub expands itself, which is how a group moves
   * together — issuing a write per shade cannot match it, because each is a
   * separate RF command.
   */
  async activateScene(sceneId: number): Promise<number[] | undefined> {
    const url = new URL(this.baseUrl('/api/scenes'));
    url.searchParams.set('sceneId', String(sceneId));
    const json = await this.fetchJson<{ shadeIds?: number[] }>(
      url.toString(),
      undefined,
      RequestPriority.Write,
    );
    // Undefined, not empty: a gen1 hub answers without shadeIds, and defaulting
    // to [] logged "activated (0 shade(s))" while five shades were moving.
    return Array.isArray(json.shadeIds) ? json.shadeIds : undefined;
  }

  /**
   * The shades a scene moves, and where it moves them to.
   *
   * Activation is expanded by the hub, so nothing in the response says which
   * shades moved. The membership does, and it carries each target position — so
   * HomeKit can be brought up to date without an RF read per shade.
   */
  async getSceneMembers(sceneId: number): Promise<PowerViewSceneMember[]> {
    const url = new URL(this.baseUrl('/api/scenemembers'));
    url.searchParams.set('sceneId', String(sceneId));
    const json = await this.fetchJson<{ sceneMemberData?: PowerViewSceneMember[] }>(
      url.toString(),
    );
    return json.sceneMemberData ?? [];
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
