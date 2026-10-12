/**
 * Structured logging (T19 / design doc §3.2 observability + Security §1):
 *  - One JSON object per line: { ts, level, event, ...fields } — machine
 *    parsable for compliance SIEM ingestion.
 *  - ZERO plaintext PII/SPII is ever logged (invariant I-6): every field is
 *    scrubbed by key (email, passport, national id, tokens…) AND by value
 *    (email-shaped strings, JWT/bearer material, long digit runs that look
 *    like identity documents). User references are UUIDs (pseudonymous),
 *    which is the only identifier allowed through.
 *  - The sink is injectable so tests can capture output.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

/** Keys whose values are always redacted, regardless of shape. */
const SENSITIVE_KEY =
  /^(email|password|passwd|token|secret|cookie|authorization|auth|api[-_]?key|session|national_?id|nationalId|passport|ssn|itin|spi[iI]|nationalIdSpii|national_id_spii|card|cvv|pan|account_?number|bank|dob|birth|phone|address|full_?name|first_?name|last_?name|name)$/i;

const REDACTED = "[redacted]";

/** Value-shape scrubbers for values that slipped through non-sensitive keys. */
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_SHAPE = /\b(?:bearer\s+|jwt[ :=]+)[A-Za-z0-9._~+/-]{16,}=*/gi;
/** 9+ consecutive digits: national ids / passports / phone numbers. */
const LONG_DIGIT_SHAPE = /\b\d{9,}\b/g;

export function scrubString(value: string): string {
  return value
    .replace(EMAIL_SHAPE, "[redacted-email]")
    .replace(BEARER_SHAPE, "[redacted-token]")
    .replace(LONG_DIGIT_SHAPE, "[redacted-digits]");
}

/** Recursively redacts sensitive keys and PII-shaped values. */
export function redact(value: unknown, keyHint = "", depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (SENSITIVE_KEY.test(keyHint)) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, keyHint, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, k, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface LogRecord extends LogFields {
  ts: string;
  level: LogLevel;
  event: string;
}

export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => process.stdout.write(line + "\n");

let sink: LogSink = defaultSink;

/** Test hook: capture or replace the sink. Returns the previous sink. */
export function setLogSink(next: LogSink): LogSink {
  const prev = sink;
  sink = next;
  return prev;
}

/**
 * Emits one structured log record. Fields are redacted before serialization —
 * callers cannot accidentally log PII by passing a raw request body.
 */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(redact(fields) as LogFields),
  };
  try {
    sink(JSON.stringify(record));
  } catch {
    // Logging must never break the request path.
  }
}

export const logger = {
  debug: (event: string, fields?: LogFields) => log("debug", event, fields),
  info: (event: string, fields?: LogFields) => log("info", event, fields),
  warn: (event: string, fields?: LogFields) => log("warn", event, fields),
  error: (event: string, fields?: LogFields) => log("error", event, fields),
};
