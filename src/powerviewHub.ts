import type { Logging } from 'homebridge';

import { formatError, logError } from './errors.js';

const INITIAL_REQUEST_DELAY_MS = 100;
const REQUEST_INTERVAL_MS = 100;

export enum HubPosition {
  BOTTOM = 1,
  TOP = 2,
  VANES = 3,
}

export interface ShadePositions {
  [key: string]: number;
}

export interface PowerViewShade {
  id: number;
  name: string;
  type?: number;
  positions?: ShadePositions;
  timedOut?: boolean;
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

export interface HubUserData {
  hubName: string;
  serialNumber: string;
  firmware?: {
    mainProcessor?: {
      name: string;
    };
  };
}

export class PowerViewHub {
  private readonly queue: QueuedRequest[] = [];

  constructor(
    private readonly log: Logging,
    private readonly host: string,
  ) {}

  private baseUrl(path: string): string {
    return `http://${this.host}${path}`;
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
      }
      return await response.json() as T;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('HTTP ')) {
        throw err;
      }
      throw new Error(
        `Failed to reach PowerView hub at ${this.host} (${url})`,
        { cause: err },
      );
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
      this.log.info('Put for', queued.shadeId, queued.data);
    }

    try {
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
    }

    this.queue.shift();
    if (this.queue.length > 0) {
      this.scheduleRequest(REQUEST_INTERVAL_MS);
    }
  }

  async getUserData(): Promise<HubUserData> {
    const json = await this.fetchJson<{ userData?: HubUserData }>(this.baseUrl('/api/userdata'));
    if (!json.userData) {
      throw new Error('Hub returned no userData from /api/userdata');
    }
    return json.userData;
  }

  async getShades(): Promise<PowerViewShade[]> {
    const json = await this.fetchJson<{ shadeData?: PowerViewShade[] }>(this.baseUrl('/api/shades'));
    if (!Array.isArray(json.shadeData)) {
      throw new Error('Hub returned no shadeData from /api/shades');
    }
    return json.shadeData;
  }

  async getShade(shadeId: number, refresh = false): Promise<PowerViewShade> {
    if (refresh) {
      return new Promise((resolve, reject) => {
        for (const queued of this.queue) {
          if (queued.shadeId === shadeId && queued.qs) {
            queued.callbacks.push((err, shade) => {
              if (err) {
                reject(err);
              } else if (shade) {
                resolve(shade);
              } else {
                reject(new Error('No shade data returned'));
              }
            });
            return;
          }
        }

        this.queueRequest({
          shadeId,
          qs: { refresh: 'true' },
          callbacks: [(err, shade) => {
            if (err) {
              reject(err);
            } else if (shade) {
              resolve(shade);
            } else {
              reject(new Error('No shade data returned'));
            }
          }],
        });
      });
    }

    const json = await this.fetchJson<{ shade?: PowerViewShade }>(
      this.baseUrl(`/api/shades/${shadeId}`),
    );
    if (!json.shade) {
      throw new Error(`Hub returned no shade data for shade ${shadeId}`);
    }
    return json.shade;
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
          const positions: Record<number, number> = {};
          for (let i = 1; queued.data.positions[`posKind${i}`]; ++i) {
            const kind = queued.data.positions[`posKind${i}`];
            positions[kind] = queued.data.positions[`position${i}`];
          }

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

          let i = 1;
          queued.data.positions = {};
          for (const posKind of Object.keys(positions)) {
            const kind = parseInt(posKind, 10);
            queued.data.positions[`posKind${i}`] = kind;
            queued.data.positions[`position${i}`] = positions[kind];
            ++i;
          }

          queued.callbacks.push((err, shade) => {
            if (err) {
              reject(err);
            } else if (shade) {
              resolve(shade);
            } else {
              reject(new Error('No shade data returned'));
            }
          });
          return;
        }
      }

      this.queueRequest({
        shadeId,
        data: {
          positions: {
            posKind1: position,
            position1: value,
          },
        },
        callbacks: [(err, shade) => {
          if (err) {
            reject(err);
          } else if (shade) {
            resolve(shade);
          } else {
            reject(new Error('No shade data returned'));
          }
        }],
      });
    });
  }

  async jogShade(shadeId: number): Promise<PowerViewShade> {
    return new Promise((resolve, reject) => {
      for (const queued of this.queue) {
        if (queued.shadeId === shadeId && queued.data?.motion === 'jog') {
          queued.callbacks.push((err, shade) => {
            if (err) {
              reject(err);
            } else if (shade) {
              resolve(shade);
            } else {
              reject(new Error('No shade data returned'));
            }
          });
          return;
        }
      }

      this.queueRequest({
        shadeId,
        data: { motion: 'jog' },
        callbacks: [(err, shade) => {
          if (err) {
            reject(err);
          } else if (shade) {
            resolve(shade);
          } else {
            reject(new Error('No shade data returned'));
          }
        }],
      });
    });
  }
}
