/** Security/Trust visual cue (design doc): a small padlock used beside sensitive actions. */
export function LockIcon({ size = 14, title = "Secured" }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img" aria-label={title} style={{ verticalAlign: "middle" }}>
      <rect x="4" y="10" width="16" height="11" rx="2" fill="currentColor" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" fill="none" />
      <circle cx="12" cy="15.5" r="1.6" fill="#fff" />
    </svg>
  );
}
