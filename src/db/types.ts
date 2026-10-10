/**
 * Driver-agnostic Drizzle database type. Production uses the Neon WebSocket
 * driver; tests use PGlite — both satisfy this shape, so services and guards
 * are written against it and never leak a driver-specific type.
 */
import type { PgDatabase } from "drizzle-orm/pg-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPgDatabase = PgDatabase<any, any, any>;
