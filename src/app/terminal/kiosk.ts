"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Kiosk protections while the terminal is activated. They make accidents hard (a long press,
 * a pinch, the back button); the operating system's kiosk mode is the real boundary.
 */
export function useKioskProtections(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const block = (event: Event) => event.preventDefault();
    const blockMultiTouch = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
    };
    const blockZoomWheel = (event: WheelEvent) => {
      if (event.ctrlKey) event.preventDefault();
    };
    const blockZoomKeys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && ["+", "-", "=", "0"].includes(event.key)) {
        event.preventDefault();
      }
    };
    // Back navigation: keep one entry ahead, and step forward again whenever it is popped.
    history.pushState(null, "", location.href);
    const onPop = () => history.pushState(null, "", location.href);

    const options = { passive: false } as const;
    document.addEventListener("contextmenu", block);
    document.addEventListener("selectstart", block);
    document.addEventListener("dragstart", block);
    document.addEventListener("gesturestart", block);
    document.addEventListener("touchmove", blockMultiTouch, options);
    document.addEventListener("wheel", blockZoomWheel, options);
    document.addEventListener("keydown", blockZoomKeys);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("contextmenu", block);
      document.removeEventListener("selectstart", block);
      document.removeEventListener("dragstart", block);
      document.removeEventListener("gesturestart", block);
      document.removeEventListener("touchmove", blockMultiTouch);
      document.removeEventListener("wheel", blockZoomWheel);
      document.removeEventListener("keydown", blockZoomKeys);
      window.removeEventListener("popstate", onPop);
    };
  }, [active]);
}

/**
 * Whether the page is outside fullscreen when it should be inside. Browsers without a
 * Fullscreen API (some tablets) cannot be held to it, so they are never reported as outside.
 */
export function useFullscreenGuard(active: boolean) {
  const [outside, setOutside] = useState(false);

  useEffect(() => {
    if (!active || !document.fullscreenEnabled) return;
    const update = () => setOutside(document.fullscreenElement === null);
    document.addEventListener("fullscreenchange", update);
    update();
    return () => document.removeEventListener("fullscreenchange", update);
  }, [active]);

  const enter = useCallback(async () => {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // The overlay stays until the browser allows it.
    }
  }, []);

  return { outside: active && outside, enter };
}

/** Keeps the screen awake while activated; re-acquired when the page becomes visible again. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        const next = await navigator.wakeLock.request("screen");
        if (cancelled) void next.release();
        else lock = next;
      } catch {
        // Denied (low battery, hidden tab): the OS power settings are the backstop.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, [active]);
}
