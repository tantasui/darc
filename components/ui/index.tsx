/**
 * The shared component set. Everything on screen is built from these, so visual changes
 * happen in one place and no screen invents its own panel or button again.
 */
import type { ReactNode } from "react";
import s from "./ui.module.css";
import { STATUS, type StatusKind } from "@/app/styles/tokens";

/** Status tone -> class, so badges carry no computed styles. */
const TONE: Record<StatusKind, string> = {
  active: s.sActive,
  approved: s.sApproved,
  declined: s.sDeclined,
  revoked: s.sRevoked,
  pending: s.sPending,
  expired: s.sExpired,
};

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

/** Generic container. Not the payment-card visual — that is <AgentCardFace>. */
export function Panel({
  children,
  title,
  note,
  action,
  flush,
  className,
}: {
  children?: ReactNode;
  title?: string;
  note?: string;
  action?: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={cx(s.panel, flush && s.panelFlush, className)}>
      {(title || action) && (
        <header className={cx(s.panelHeader, flush && s.panelHeaderFlush)}>
          <div>
            {title && <h2 className={s.panelTitle}>{title}</h2>}
            {note && <p className={cx(s.panelNote, s.leadTight)}>{note}</p>}
          </div>
          {action}
        </header>
      )}
      {!title && note && <p className={s.panelNote}>{note}</p>}
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  block,
  size,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "destructive" | "ghost";
  disabled?: boolean;
  block?: boolean;
  size?: "lg";
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx(s.btn, s[variant], block && s.block, size === "lg" && s.lg)}
    >
      {children}
    </button>
  );
}

export function StatusBadge({ kind, label }: { kind: StatusKind; label?: string }) {
  return (
    <span className={cx(s.badge, TONE[kind])}>
      <span className={cx(s.dot, kind === "pending" && s.dotPending)} />
      {label ?? STATUS[kind].label}
    </span>
  );
}

export function DataRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className={s.row}>
      <span className={s.rowLabel}>{label}</span>
      <span className={cx(s.rowValue, mono && s.mono)}>{value}</span>
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={s.empty}>
      <div className={s.emptyTitle}>{title}</div>
      {children}
    </div>
  );
}

export function Skeleton({ width = "100%", height }: { width?: string; height?: number }) {
  return <div className={s.skeleton} style={{ width, height }} />;
}

/**
 * Product error states, not error dumps: a calm sentence, then what to do about it.
 */
export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "error";
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx(s.notice, tone === "error" ? s.noticeError : s.noticeInfo)}>
      <div>
        {title && <div className={s.noticeTitle}>{title}</div>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export { s as ui };
