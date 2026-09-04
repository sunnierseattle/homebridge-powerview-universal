/**
 * Test doubles for the slice of the Homebridge API this plugin uses.
 *
 * Services and characteristics are the real HAP implementations, so
 * characteristic validation, subtypes and linked services behave as they do in
 * production. Only the accessory container and the plugin-facing API surface
 * are stood in for. Excluded from tsconfig, so it never reaches dist.
 */
import { Categories, Characteristic, Service, uuid } from '@homebridge/hap-nodejs';
import type { API, Logging, PlatformAccessory } from 'homebridge';
import { vi } from 'vitest';

import type { ShadeContext } from './settings.js';

export function createLog(): Logging {
  const log = Object.assign(vi.fn(), {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    prefix: 'test',
  });
  return log as unknown as Logging;
}

class HarnessAccessory {
  readonly services: Service[] = [];
  context: Partial<ShadeContext> = {};
  category: number = Categories.OTHER;
  reachable = true;

  constructor(public displayName: string, public readonly UUID: string, category?: number) {
    if (category !== undefined) {
      this.category = category;
    }
    this.addService(Service.AccessoryInformation);
  }

  addService(service: Service | typeof Service, ...args: unknown[]): Service {
    const instance = service instanceof Service
      ? service
      : new (service as new (name?: string, subtype?: string) => Service)(
        args[0] as string | undefined,
        args[1] as string | undefined,
      );
    this.services.push(instance);
    return instance;
  }

  removeService(service: Service): void {
    const index = this.services.indexOf(service);
    if (index >= 0) {
      this.services.splice(index, 1);
    }
  }

  getService(target: typeof Service | string): Service | undefined {
    return this.services.find((s) => (
      typeof target === 'string' ? s.displayName === target : s instanceof target
    ));
  }

  getServiceById(target: typeof Service, subtype: string): Service | undefined {
    return this.services.find((s) => s instanceof target && s.subtype === subtype);
  }

  on(): this {
    return this;
  }
}

export interface Harness {
  api: API;
  log: Logging;
  /** Fires the Homebridge lifecycle event of that name. */
  emit(event: 'didFinishLaunching' | 'shutdown'): Promise<void>;
  registered: PlatformAccessory<ShadeContext>[];
  unregistered: PlatformAccessory<ShadeContext>[];
  updated: PlatformAccessory<ShadeContext>[][];
  newAccessory(
    displayName: string,
    context: Partial<ShadeContext>,
  ): PlatformAccessory<ShadeContext>;
}

export function createHarness(): Harness {
  const listeners = new Map<string, Array<() => void>>();
  const registered: PlatformAccessory<ShadeContext>[] = [];
  const unregistered: PlatformAccessory<ShadeContext>[] = [];
  const updated: PlatformAccessory<ShadeContext>[][] = [];

  const api = {
    hap: { Service, Characteristic, Categories, uuid },
    platformAccessory: HarnessAccessory,
    on(event: string, listener: () => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return api;
    },
    registerPlatformAccessories(
      _plugin: string,
      _platform: string,
      accessories: PlatformAccessory<ShadeContext>[],
    ) {
      registered.push(...accessories);
    },
    unregisterPlatformAccessories(
      _plugin: string,
      _platform: string,
      accessories: PlatformAccessory<ShadeContext>[],
    ) {
      unregistered.push(...accessories);
    },
    updatePlatformAccessories(accessories: PlatformAccessory<ShadeContext>[]) {
      updated.push([...accessories]);
    },
  } as unknown as API;

  return {
    api,
    log: createLog(),
    async emit(event) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
      await Promise.resolve();
    },
    registered,
    unregistered,
    updated,
    newAccessory(displayName, context) {
      const accessory = new HarnessAccessory(
        displayName,
        uuid.generate(displayName),
        Categories.WINDOW_COVERING,
      ) as unknown as PlatformAccessory<ShadeContext>;
      Object.assign(accessory.context, context);
      return accessory;
    },
  };
}
