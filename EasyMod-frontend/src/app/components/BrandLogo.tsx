import { lazy, Suspense } from "react";

const AnimatedBrandLogo = lazy(() => import("./AnimatedBrandLogo"));

interface BrandLogoProps {
  size?: "sm" | "md" | "lg";
  variant?: "light" | "dark";
  animated?: boolean;
  /** Hide the wordmark and render the mark alone — for the collapsed sidebar rail. */
  iconOnly?: boolean;
  /** Additive wordmark tone override (shell uses em ink); default unchanged. */
  wordmarkClass?: string;
  /** Scope a supplied brand mark to a specific surface without changing public branding. */
  markSrc?: string;
}

const sizeMap = {
  sm: { icon: 32, text: "text-lg" },
  md: { icon: 40, text: "text-xl" },
  lg: { icon: 48, text: "text-2xl" },
};

/**
 * Below this the full logo (cyclist, taka symbol, ring) is an indistinct green
 * blob, so we swap to the simplified bubble-and-arrow mark. Tune here — it is
 * the one number worth revisiting once the logo is live.
 */
const FULL_LOGO_MIN_PX = 40;

// ?v= matches index.html. nginx serves .svg as immutable/1y and .png for 30d
// (nginx.conf), so a future logo change needs this bumped or nobody sees it.
const FULL_LOGO_SRC = "/brand/logo-192.png?v=2";
const MARK_SRC = "/brand/mark.svg?v=2";

export default function BrandLogo({
  size = "md",
  variant = "dark",
  animated = false,
  iconOnly = false,
  wordmarkClass,
  markSrc,
}: BrandLogoProps) {
  const { icon, text } = sizeMap[size];
  const textColor = variant === "light" ? "text-white" : "text-gray-900";

  const iconEl = (
    <img
      src={markSrc ?? (icon >= FULL_LOGO_MIN_PX ? FULL_LOGO_SRC : MARK_SRC)}
      width={icon}
      height={icon}
      alt=""
      aria-hidden="true"
      className="shrink-0"
      style={{ width: icon, height: icon }}
    />
  );

  // `light` means the logo sits on a coloured surface — the green sign-in hero
  // and the navy landing footer. The mark is green, so on the green panel it
  // vanishes into the background; the white plate is what keeps it readable.
  const platedIcon =
    variant === "light" ? (
      <span className="shrink-0 rounded-full bg-white p-1">{iconEl}</span>
    ) : (
      iconEl
    );

  const contents = (
    <>
      {platedIcon}
      {!iconOnly && (
        <span className={`font-bold tracking-tight ${text} ${wordmarkClass ?? textColor}`}>EasyModerator</span>
      )}
    </>
  );

  const staticLogo = <div className="flex items-center gap-2.5 select-none">{contents}</div>;
  return animated ? (
    <Suspense fallback={staticLogo}>
      <AnimatedBrandLogo>{contents}</AnimatedBrandLogo>
    </Suspense>
  ) : staticLogo;
}
