/**
 * Atlas — the demo agent.
 *
 * This is deliberately NOT a row of buttons. The agent holds a short list of goals, picks an
 * amount and a merchant per goal, and — crucially — reacts differently depending on WHY it
 * was refused:
 *
 *   over the daily cap   -> records the shortfall, defers that goal, carries on with the rest
 *   merchant not allowed -> marks the goal blocked and does not retry it
 *   card revoked         -> stops entirely; nothing further will ever succeed
 *
 * That branching is what separates "an agent working through its tasks" from "a human
 * clicking step 2 of 3". It is deterministic and needs no LLM, which keeps the demo safe to
 * run live, but the decisions are the agent's rather than the operator's.
 */
import type { Address } from "viem";
import { MERCHANTS } from "@/config/merchants";

export const AGENT = {
  name: "Atlas",
  persona: "Procurement assistant",
  brief: "Keeps the team's infrastructure paid for, within whatever limits it is given.",
} as const;

export type Task = {
  id: string;
  goal: string;
  merchant: Address;
  merchantName: string;
  amountUsd: number;
};

/** Hardcoded goals, sized so the three canonical outcomes arise from the agent's own choices. */
export const TASKS: Task[] = [
  {
    id: "hosting",
    goal: "Renew monthly hosting",
    merchant: MERCHANTS[0].address,
    merchantName: MERCHANTS[0].name,
    amountUsd: 20,
  },
  {
    id: "api-credits",
    goal: "Top up API credits",
    merchant: MERCHANTS[1].address,
    merchantName: MERCHANTS[1].name,
    amountUsd: 200,
  },
  {
    id: "data-feed",
    goal: "Pay data feed subscription",
    merchant: MERCHANTS[2].address,
    merchantName: MERCHANTS[2].name,
    amountUsd: 15,
  },
];

export type Line = {
  at: number;
  who: "agent" | "chain";
  text: string;
  tone?: "ok" | "declined" | "note";
};

export type TaskOutcome = "done" | "deferred" | "blocked" | "halted" | "skipped";

export const line = (who: Line["who"], text: string, tone?: Line["tone"]): Line => ({
  at: Date.now(),
  who,
  text,
  tone,
});

/** What the agent says before it tries — stating intent, not narrating a click. */
export function intendLine(task: Task): Line {
  return line("agent", `Working on "${task.goal}". Authorising $${task.amountUsd} to ${task.merchantName}.`);
}

/**
 * The decision: given a refusal reason, what does the agent conclude and do next?
 * Returns the outcome for this task and whether the run should continue at all.
 */
export function decide(
  task: Task,
  ok: boolean,
  reason: string | null,
  remainingUsd: number,
): { outcome: TaskOutcome; stopRun: boolean; lines: Line[] } {
  if (ok) {
    return {
      outcome: "done",
      stopRun: false,
      lines: [line("agent", `Paid $${task.amountUsd} to ${task.merchantName}. "${task.goal}" is settled.`, "ok")],
    };
  }

  switch (reason) {
    case "DailyCapExceeded": {
      const short = Math.max(task.amountUsd - remainingUsd, 0);
      return {
        outcome: "deferred",
        stopRun: false,
        lines: [
          line("chain", `Refused: DailyCapExceeded.`, "declined"),
          line(
            "agent",
            `That is $${short} more than today's remaining limit of $${remainingUsd}. Deferring "${task.goal}" until the limit resets rather than retrying — a smaller payment would not cover the invoice.`,
            "note",
          ),
        ],
      };
    }
    case "MerchantNotAllowed":
      return {
        outcome: "blocked",
        stopRun: false,
        lines: [
          line("chain", `Refused: MerchantNotAllowed.`, "declined"),
          line(
            "agent",
            `${task.merchantName} is not on this card's allow-list, so retrying cannot help. Marking "${task.goal}" blocked and asking the owner to add the merchant.`,
            "note",
          ),
        ],
      };
    case "CardRevoked":
      return {
        outcome: "halted",
        stopRun: true,
        lines: [
          line("chain", `Refused: CardRevoked.`, "declined"),
          line("agent", `This card has been revoked. Stopping — no further payment can succeed.`, "note"),
        ],
      };
    case "CardExpired":
      return {
        outcome: "halted",
        stopRun: true,
        lines: [
          line("chain", `Refused: CardExpired.`, "declined"),
          line("agent", `The card is past its validity date. Stopping and asking for a new one.`, "note"),
        ],
      };
    default:
      return {
        outcome: "blocked",
        stopRun: false,
        lines: [
          line("chain", `Refused: ${reason ?? "unknown reason"}.`, "declined"),
          line("agent", `I cannot act on that refusal, so I am leaving "${task.goal}" for the owner.`, "note"),
        ],
      };
  }
}

/** Closing summary, so a run ends with a conclusion rather than just stopping. */
export function summarise(outcomes: Record<string, TaskOutcome>): Line {
  const counts = Object.values(outcomes);
  const done = counts.filter((o) => o === "done").length;
  const deferred = counts.filter((o) => o === "deferred").length;
  const blocked = counts.filter((o) => o === "blocked").length;
  const halted = counts.some((o) => o === "halted");

  if (halted) return line("agent", `Run stopped early: the card is no longer usable.`, "note");
  const parts = [`${done} settled`];
  if (deferred) parts.push(`${deferred} deferred to tomorrow`);
  if (blocked) parts.push(`${blocked} needs the owner`);
  return line("agent", `Done for now — ${parts.join(", ")}.`, "note");
}
