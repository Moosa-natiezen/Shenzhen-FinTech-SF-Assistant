"use client";
/**
 * Credit Builder gauge (T16): a gamified circular progress ring translating the
 * R_score into visible progress, with CONTEXTUAL FINANCIAL EDUCATION tooltips
 * explaining how specific actions move the score (design doc).
 */
const R_MIN = 300;
const R_MAX = 850;

function progressOf(score: number): number {
  return Math.min(1, Math.max(0, (score - R_MIN) / (R_MAX - R_MIN)));
}

export function CreditGauge({ score }: { score: number | null }) {
  const s = score ?? R_MIN;
  const progress = progressOf(s);
  const radius = 62;
  const c = 2 * Math.PI * radius;
  const offset = c * (1 - progress);

  return (
    <div className="card gauge-wrap">
      <h2>Credit Builder</h2>
      <svg width="180" height="180" viewBox="0 0 160 160" role="img" aria-label={`R_score ${s} of 850`}>
        <circle cx="80" cy="80" r={radius} fill="none" stroke="var(--surface-2)" strokeWidth="14" />
        <circle
          cx="80"
          cy="80"
          r={radius}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform="rotate(-90 80 80)"
        />
        <text x="80" y="78" textAnchor="middle" fontSize="30" fontWeight="800" fill="var(--text)">
          {s}
        </text>
        <text x="80" y="98" textAnchor="middle" fontSize="11" fill="var(--muted)">
          / {R_MAX}
        </text>
      </svg>
      <div className="muted">Built from on-time tuition &amp; financial behaviour</div>

      <div style={{ marginTop: 12, display: "grid", gap: 8, width: "100%" }}>
        <Edu
          title="Pay tuition on time"
          tip="On-time institutional tuition payments are the biggest driver — T_tuition carries 40% of your R_score. Each settled payment moves the gauge."
        />
        <Edu
          title="Keep a healthy host balance"
          tip="A stable average host-currency wallet balance (S_wallet) contributes 15% of your score. Avoid letting it sit at zero."
        />
        <Edu
          title="Why this matters"
          tip="International students start 'credit-invisible'. Building a local R_score here helps with housing, utilities, and secured credit lines later."
        />
      </div>
    </div>
  );
}

function Edu({ title, tip }: { title: string; tip: string }) {
  return (
    <div className="row" style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "8px 10px" }}>
      <span>{title}</span>
      <span className="tooltip" tabIndex={0}>
        <span className="help" aria-hidden>?</span>
        <span className="tip" role="tooltip">{tip}</span>
      </span>
    </div>
  );
}
