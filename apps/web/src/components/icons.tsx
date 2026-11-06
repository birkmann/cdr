import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function I({ size = 16, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconPlus = (p: P) => (
  <I {...p}>
    <path d="M12 5v14M5 12h14" />
  </I>
);
export const IconSearch = (p: P) => (
  <I {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </I>
);
export const IconSend = (p: P) => (
  <I {...p}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </I>
);
export const IconStop = (p: P) => (
  <I {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
  </I>
);
export const IconPaperclip = (p: P) => (
  <I {...p}>
    <path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" />
  </I>
);
export const IconFolder = (p: P) => (
  <I {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </I>
);
export const IconChevron = (p: P) => (
  <I {...p}>
    <path d="m6 9 6 6 6-6" />
  </I>
);
export const IconChevronRight = (p: P) => (
  <I {...p}>
    <path d="m9 6 6 6-6 6" />
  </I>
);
export const IconX = (p: P) => (
  <I {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </I>
);
export const IconTrash = (p: P) => (
  <I {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </I>
);
export const IconSettings = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </I>
);
export const IconCode = (p: P) => (
  <I {...p}>
    <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
  </I>
);
export const IconPanel = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </I>
);
export const IconFile = (p: P) => (
  <I {...p}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
  </I>
);
export const IconCheck = (p: P) => (
  <I {...p}>
    <path d="m5 12 5 5L20 7" />
  </I>
);
export const IconAlert = (p: P) => (
  <I {...p}>
    <path d="M12 9v4M12 17h.01" />
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  </I>
);
export const IconTerminal = (p: P) => (
  <I {...p}>
    <path d="m4 17 6-6-6-6M12 19h8" />
  </I>
);
export const IconSparkle = (p: P) => (
  <I {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
  </I>
);
export const IconMenu = (p: P) => (
  <I {...p}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </I>
);
export const IconUp = (p: P) => (
  <I {...p}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </I>
);
export const IconGit = (p: P) => (
  <I {...p}>
    <circle cx="6" cy="6" r="2" />
    <circle cx="6" cy="18" r="2" />
    <circle cx="18" cy="9" r="2" />
    <path d="M6 8v8M18 11a6 6 0 0 1-6 6H8" />
  </I>
);
export const IconExternal = (p: P) => (
  <I {...p}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </I>
);
export const IconPlay = (p: P) => (
  <I {...p}>
    <path d="M7 5v14l11-7z" fill="currentColor" />
  </I>
);
export const IconRefresh = (p: P) => (
  <I {...p}>
    <path d="M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4" />
  </I>
);
export const IconMonitor = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M8 20h8M12 16v4" />
  </I>
);
export const IconTablet = (p: P) => (
  <I {...p}>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M11 18h2" />
  </I>
);
export const IconPhone = (p: P) => (
  <I {...p}>
    <rect x="7" y="3" width="10" height="18" rx="2" />
    <path d="M11 18h2" />
  </I>
);
export const IconCopy = (p: P) => (
  <I {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </I>
);
export const IconChart = (p: P) => (
  <I {...p}>
    <path d="M4 20h16M7 16v-4M12 16V7M17 16v-7" />
  </I>
);
