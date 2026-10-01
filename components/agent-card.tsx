/**
 * The card face — the product's one memorable image, so it is built to actually look like a
 * payment card: ISO aspect ratio, chip, masked number, and a status that changes the FACE
 * rather than a label underneath it. A revoked card is visibly dead.
 */
import { formatUnits } from "viem";
import { Mark } from "./brand";
import c from "./agent-card.module.css";

export type CardFaceProps = {
  /** Last four of the agent address, which is what "•• A55A" masks. */
  last4: string;
  agentName: string;
  persona?: string;
  dailyCap: bigint;
  remaining?: bigint;
  revoked: boolean;
  expired?: boolean;
  merchantCount: number;
  small?: boolean;
};

export function AgentCardFace({
  last4,
  agentName,
  persona,
  dailyCap,
  remaining,
  revoked,
  expired,
  merchantCount,
  small,
}: CardFaceProps) {
  const state = revoked ? "revoked" : expired ? "expired" : "active";
  return (
    <div
      className={[c.face, small && c.faceSm, revoked && c.revoked, !revoked && expired && c.expired]
        .filter(Boolean)
        .join(" ")}
    >
      <div className={c.top}>
        <span className={c.issuer}>
          <Mark size={17} />
          AgentCard
        </span>
        <span
          className={[c.corner, state === "active" ? c.cornerActive : state === "revoked" ? c.cornerRevoked : ""]
            .filter(Boolean)
            .join(" ")}
        >
          {state}
        </span>
      </div>

      {!small && <div className={c.chip} />}

      <div>
        <div className={c.number}>
          <span className={c.dots}>•••• ••••</span>
          <span>{last4}</span>
        </div>
      </div>

      <div className={c.bottom}>
        <div>
          <div className={c.label}>Agent</div>
          <div className={c.agentName}>{agentName}</div>
          {persona && <div className={c.persona}>{persona}</div>}
        </div>
        <div className={c.right}>
          <div className={c.label}>Daily limit</div>
          <div className={c.value}>${formatUnits(dailyCap, 6)}</div>
          {!revoked && remaining !== undefined && (
            <div className={c.persona}>${formatUnits(remaining, 6)} left today</div>
          )}
          <div className={c.persona}>
            {merchantCount === 0 ? "any merchant" : `${merchantCount} merchant${merchantCount > 1 ? "s" : ""}`}
          </div>
        </div>
      </div>
    </div>
  );
}
