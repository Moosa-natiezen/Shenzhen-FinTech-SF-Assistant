/** Shared API response types (mirror the Hono gateway's JSON shapes). */

export type AppRole = "student" | "sponsor" | "compliance_admin";

export interface Me {
  user: { id: string; email: string; name: string };
  roles: AppRole[];
  mfaEnrolled: boolean;
}

export interface Wallet {
  id: string;
  userId: string;
  currency: string;
  kind: string; // home | host
  balance: string; // exact decimal string
  createdAt: string;
  updatedAt: string;
}

export interface RateLock {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  fxSpot: string;
  fxFinal: string;
  margin: string;
  amountBase: string;
  feeFlat: string;
  expiresAt: string; // ISO
}

export interface Conversion {
  transactionId: string;
  fxFinal: string;
  feeFlat: string;
  amountBase: string;
  hostCredited: string;
  homeBalance: string;
  hostBalance: string;
}

export interface FundingResult {
  transactionId: string;
  transferId: string;
  amount: string;
  amountTo?: string;
  fxFinal?: string | null;
  walletBalance: string;
}

export interface University {
  id: string;
  name: string;
  country: string;
  currency: string;
  verified: boolean;
}

export interface Receipt {
  id: string;
  transactionId: string;
  universityId: string;
  currency: string;
  amount: string;
  status: string;
  receiptHash: string;
  newScore?: number;
}

export interface ReceiptRow {
  id: string;
  universityId: string;
  currency: string;
  amount: string;
  status: string;
  receiptHash: string;
  createdAt: string;
  studentUserId: string;
}

export interface Score {
  score: number;
  computedAt: string;
}

export interface Metro2Record {
  segmentType: "B";
  accountNumber: string;
  portfolioType: string;
  accountType: string;
  paymentRating: string;
  originalBalance: string;
  currentBalance: string;
  dateOpened: string | null;
  rscore: number;
}

export interface Metro2Export {
  exportId: string;
  generatedAt: string;
  records: Metro2Record[];
  checksum: string;
}

export interface FundingSource {
  id: string;
  currency: string;
  kind: string;
  balance: string;
}

export interface FlaggedTransfer {
  id: string;
  occurredAt: string;
  senderUserId: string;
  recipientUserId: string | null;
  fromCurrency: string;
  toCurrency: string;
  amountFrom: string;
  kind: string;
  status: string;
  screeningReason: string | null;
  flags: string[];
}
