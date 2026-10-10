import type { Viewport } from "next";
import type { ReactNode } from "react";

/** No zoom, no scaling: the kiosk is operated by touch at a fixed size. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

/**
 * The Voting Terminal's layout. It deliberately holds nothing but the page: no navigation, no
 * links, no admin or staff code, so the route's bundle stays small.
 */
export default function TerminalLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-h-screen select-none bg-zinc-100 text-zinc-900"
      style={{ touchAction: "manipulation", WebkitTouchCallout: "none" }}
    >
      {children}
    </div>
  );
}
