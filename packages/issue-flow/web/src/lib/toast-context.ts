import { getContext, setContext } from 'svelte';
import type { ToastInput } from './types';

/**
 * PORT of `frontend/src/lib/toast-context.ts` @ d8c9d5f (27 lines).
 *
 * The no-op fallback is the point: a component rendered outside the app shell
 * (a test, a dialog mounted on its own) still calls `toast.success(...)`, and
 * making that throw would turn "no toast host" into a crash in the middle of an
 * otherwise successful action.
 */

export interface ToastController {
  show: (toast: ToastInput) => void;
  info: (message: string, detail?: string) => void;
  success: (message: string, detail?: string) => void;
  error: (message: string, detail?: string) => void;
}

const TOAST_CONTROLLER = Symbol('toast-controller');

export function setToastController(controller: ToastController): void {
  setContext(TOAST_CONTROLLER, controller);
}

export function getToastController(): ToastController {
  const controller = getContext<ToastController | undefined>(TOAST_CONTROLLER);
  if (controller) return controller;

  return {
    show: () => {},
    info: () => {},
    success: () => {},
    error: () => {},
  };
}
