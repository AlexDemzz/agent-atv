import type { Device, DeviceManager, PluginState } from '../devices/manager';

const TICK_MS = 100;

/**
 * Resolves true as soon as `check` holds for the device's State (re-checked on every State update
 * and every 100 ms), or false once `timeoutMs` elapses or `signal` aborts.
 */
export function waitForState(
  devices: DeviceManager,
  device: Device,
  check: (state: PluginState) => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (outcome: boolean | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(ticker);
      devices.off('state', onState);
      signal?.removeEventListener('abort', onAbort);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    // Runs from timers and event listeners, so a throwing check must not escape as an uncaught exception.
    const evaluate = () => {
      try {
        if (check(devices.pluginState(device))) finish(true);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onState = (changed: Device) => {
      if (changed === device) evaluate();
    };
    const onAbort = () => finish(false);
    // Timers may fire a millisecond early; re-arm until the deadline really passed.
    const arm = () => {
      timer = setTimeout(() => {
        evaluate();
        if (settled) return;
        if (Date.now() < deadline) arm();
        else finish(false);
      }, Math.max(1, deadline - Date.now()));
    };
    arm();
    const ticker = setInterval(evaluate, TICK_MS);
    devices.on('state', onState);
    signal?.addEventListener('abort', onAbort);
    evaluate();
  });
}
