/**
 * Token accessors for the few places that need values in TypeScript (inline SVG fills,
 * computed gradients). Everything else reads the CSS variables in app/globals.css —
 * these names must stay in step with that file.
 */
export const STATUS = {
  active: { label: "Active", color: "var(--ok)", bg: "var(--ok-dim)" },
  approved: { label: "Approved", color: "var(--ok)", bg: "var(--ok-dim)" },
  declined: { label: "Declined", color: "var(--declined)", bg: "var(--declined-dim)" },
  revoked: { label: "Revoked", color: "var(--revoked)", bg: "var(--revoked-dim)" },
  pending: { label: "Pending", color: "var(--pending)", bg: "var(--pending-dim)" },
  expired: { label: "Expired", color: "var(--text-dim)", bg: "var(--ink-700)" },
} as const;

export type StatusKind = keyof typeof STATUS;
