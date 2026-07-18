import { expect } from 'vitest';

export interface LeakTracked {
  close(): void;
}

const _registry = new Set<LeakTracked>();
const _creationStacks = new Map<LeakTracked, string>();

export function registerTracked(obj: LeakTracked): void {
  _registry.add(obj);
  if (!_creationStacks.has(obj)) {
    _creationStacks.set(obj, new Error('Resource created here').stack ?? '');
  }
}

export function unregisterTracked(obj: LeakTracked): void {
  _registry.delete(obj);
  _creationStacks.delete(obj);
}

export function isClosed(obj: LeakTracked): boolean {
  return !_registry.has(obj);
}

export function assertNotClosed(obj: LeakTracked): void {
  if (!_registry.has(obj)) {
    const err = new Error(
      `InvalidStateError: Cannot call method on a closed resource.`
    );
    throw err;
  }
}

export function expectNoLeaks(): void {
  if (_registry.size > 0) {
    const entries = Array.from(_registry);
    const details = entries
      .map((obj, i) => {
        const stack = _creationStacks.get(obj) || 'no stack';
        return `[${i}] ${obj.constructor.name || 'UnknownResource'}:\n${stack}`;
      })
      .join('\n\n');
    throw new Error(
      `Leak detected: ${_registry.size} resource(s) not closed.\n\n${details}`
    );
  }
}

export function resetLeakRegistry(): void {
  _registry.clear();
  _creationStacks.clear();
}
