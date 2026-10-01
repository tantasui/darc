/**
 * Wordmark and icon. The mark is a card with a clipped corner and a chip — geometric, so it
 * reads at favicon size, and it leans into the card metaphor the product is built on.
 */
import b from "./brand.module.css";

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <defs>
        <linearGradient id="markFace" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5f8aff" />
          <stop offset="1" stopColor="#2b4fd6" />
        </linearGradient>
      </defs>
      <path d="M4 9.5A3.5 3.5 0 0 1 7.5 6h17A3.5 3.5 0 0 1 28 9.5v8l-6 6H7.5A3.5 3.5 0 0 1 4 20V9.5Z" fill="url(#markFace)" />
      <rect x="7.5" y="10" width="7" height="5" rx="1.4" fill="#0a0e17" fillOpacity="0.55" />
      <path d="M28 17.5 22 23.5v-6h6Z" fill="#9ab6ff" />
    </svg>
  );
}

export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <span className={b.wordmark}>
      <Mark size={size} />
      {/* Only the font size varies with the mark size, so it stays a CSS variable. */}
      <span className={b.name} style={{ fontSize: size * 0.78 }}>
        Agent<span className={b.nameMuted}>Card</span>
      </span>
    </span>
  );
}
