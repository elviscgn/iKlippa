import type { EnginePorts } from './types';
import { browserEnginePorts } from './browser';

let _ports: EnginePorts = { ...browserEnginePorts };

export function getPorts(): EnginePorts {
  return _ports;
}

export function setPorts(ports: Partial<EnginePorts>): void {
  _ports = { ..._ports, ...ports };
}

export function resetPorts(): void {
  _ports = { ...browserEnginePorts };
}

export type { EnginePorts } from './types';
export * from './types';
