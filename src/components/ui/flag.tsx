import * as React from "react";

import { cn } from "@/lib/utils";

type FlagProps = React.ComponentProps<"svg">;

/**
 * Inline SVG flag icons used in the language switcher.
 *
 * Why not emoji?
 * Windows does not ship glyphs for regional indicator pairs in its system
 * emoji font, so flag emojis like 🇸🇪 / 🇬🇧 render as the underlying letter
 * pairs ("SE" / "GB") in Chrome on Windows. Inline SVG renders identically
 * across every OS.
 */

function FlagSE({ className, ...props }: FlagProps) {
  return (
    <svg
      data-slot="flag"
      data-flag="se"
      viewBox="0 0 16 10"
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-hidden="true"
      className={cn("inline-block h-3 w-5 overflow-hidden rounded-[2px]", className)}
      {...props}
    >
      <title>Sweden</title>
      <rect width="16" height="10" fill="#006AA7" />
      <rect x="0" y="4" width="16" height="2" fill="#FECC00" />
      <rect x="5" y="0" width="2" height="10" fill="#FECC00" />
    </svg>
  );
}

function FlagGB({ className, ...props }: FlagProps) {
  const reactId = React.useId();
  const frameClip = `flag-gb-frame-${reactId}`;
  const patrickClip = `flag-gb-patrick-${reactId}`;

  return (
    <svg
      data-slot="flag"
      data-flag="gb"
      viewBox="0 0 60 30"
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-hidden="true"
      className={cn("inline-block h-3 w-5 overflow-hidden rounded-[2px]", className)}
      {...props}
    >
      <title>United Kingdom</title>
      <clipPath id={frameClip}>
        <path d="M0 0v30h60V0z" />
      </clipPath>
      <clipPath id={patrickClip}>
        <path d="M30 15l30 15v-2L32 13zM30 15v15h-2V17L2 30H0v-2zM30 15L0 0h2l28 13V0h2zM30 15h30V0h-2L30 13z" />
      </clipPath>
      <g clipPath={`url(#${frameClip})`}>
        {/* Blue field */}
        <path fill="#012169" d="M0 0v30h60V0z" />
        {/* White saltire (St Andrew) */}
        <path stroke="#FFFFFF" strokeWidth="6" d="M0 0l60 30M60 0L0 30" />
        {/* Red saltire (St Patrick), offset via clip */}
        <path
          stroke="#C8102E"
          strokeWidth="4"
          clipPath={`url(#${patrickClip})`}
          d="M0 0l60 30M60 0L0 30"
        />
        {/* White cross (St George background) */}
        <path stroke="#FFFFFF" strokeWidth="10" d="M30 0v30M0 15h60" />
        {/* Red cross (St George) */}
        <path stroke="#C8102E" strokeWidth="6" d="M30 0v30M0 15h60" />
      </g>
    </svg>
  );
}

export { FlagSE, FlagGB };
