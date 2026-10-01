/** Inline icons — no icon dependency. 16px stroke set, consistent weight. */
type P = { size?: number };
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const HomeIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M2.5 6.8 8 2.5l5.5 4.3V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V6.8Z" />
  </svg>
);
export const CardsIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <rect x="1.8" y="3.6" width="12.4" height="8.8" rx="1.6" />
    <path d="M1.8 6.6h12.4" />
  </svg>
);
export const ActivityIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M1.6 8h3l1.6-4 2.4 8L12 8h2.4" />
  </svg>
);
export const AgentsIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="8" cy="5.6" r="2.6" />
    <path d="M3 13.4c0-2.3 2.2-3.6 5-3.6s5 1.3 5 3.6" />
  </svg>
);
export const VerifyIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M8 1.9l5 1.9v4c0 3-2.1 5.3-5 6.3-2.9-1-5-3.3-5-6.3v-4l5-1.9Z" />
    <path d="M5.9 7.9 7.4 9.4l2.9-3" />
  </svg>
);
export const SettingsIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.6v1.7M8 12.7v1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M1.6 8h1.7M12.7 8h1.7M3.5 12.5l1.2-1.2M11.3 4.7l1.2-1.2" />
  </svg>
);
export const PlusIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M8 3.4v9.2M3.4 8h9.2" />
  </svg>
);
export const ExternalIcon = ({ size = 13 }: P) => (
  <svg {...base(size)}>
    <path d="M6.4 3.4H3.6a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V8.6M9 2.5h4.5V7M13.3 2.7 7.4 8.6" />
  </svg>
);
