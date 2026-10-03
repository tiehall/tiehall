import { createHash } from "node:crypto";
import type { drizzleAdapter } from "better-auth/adapters/drizzle";

// How the install keeps the codes of the CLI's device flow (agent-access: The
// CLI signs in through a restricted device flow; design.md, Design rules:
// Agent access). A device code redeems tokens for the 10 minutes it lives,
// and its user code approves it, so the install keeps neither as it is, only
// its SHA-256 hash, as it keeps personal access tokens: a reader of the
// database finds no code to redeem or approve, and the hash it finds redeems
// nothing, since every code the token endpoint is given is hashed before it
// is looked up. Better Auth's device authorization plugin stores and looks up
// the codes through the database adapter and offers no hook of its own for
// it, so the adapter is wrapped: for the plugin's device codes alone, every
// code a row is stored with, and every code a lookup names, is hashed, and a
// row found by a code carries that code again, as the plugin compares it.
// Tiehall's own reads of the table hash the code they look for the same way
// (device-flow.ts, device-approval.ts).

/** A device code or a user code as the install keeps it: its SHA-256 hash, in hex, marked as one. */
export function storedDeviceCode(code: string): string {
  return `sha256:${createHash("sha256").update(code, "utf8").digest("hex")}`;
}

type AdapterInstance = ReturnType<typeof drizzleAdapter>;
type Adapter = ReturnType<AdapterInstance>;
type TransactionAdapter = Parameters<Parameters<Adapter["transaction"]>[0]>[0];
type Where = NonNullable<Parameters<Adapter["findMany"]>[0]["where"]>[number];

/** The plugin's model of device codes, by the name it gives the adapter. */
const MODEL = "deviceCode";
/** The fields that hold a code. */
const CODE_FIELDS: readonly string[] = ["deviceCode", "userCode"];

/** The lookup, with each code it names hashed. */
function hashedWhere<W extends Where[] | undefined>(where: W): W {
  if (where === undefined) return where;
  return where.map((clause) => {
    if (!CODE_FIELDS.includes(clause.field)) return clause;
    const value = clause.value;
    if (typeof value === "string") return { ...clause, value: storedDeviceCode(value) };
    if (Array.isArray(value)) return { ...clause, value: (value as unknown[]).map((each) => (typeof each === "string" ? storedDeviceCode(each) : each)) as string[] };
    return clause;
  }) as W;
}

/** The values to store, with each code hashed. */
function hashedData<T extends Record<string, unknown>>(data: T): T {
  const hashed: Record<string, unknown> = { ...data };
  for (const field of CODE_FIELDS) if (typeof hashed[field] === "string") hashed[field] = storedDeviceCode(hashed[field]);
  return hashed as T;
}

/** A row as the plugin reads it: each code the lookup named, in place of its hash, as the plugin compares it with what it was given. */
function asNamed<T>(row: T, where: readonly Where[] | undefined): T {
  if (row === null || typeof row !== "object") return row;
  const named: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const clause of where ?? []) {
    if (!CODE_FIELDS.includes(clause.field) || typeof clause.value !== "string") continue;
    if (named[clause.field] === storedDeviceCode(clause.value)) named[clause.field] = clause.value;
  }
  return named as T;
}

/** The adapter, or a transaction's, with the device codes hashed. */
function hashing<A extends TransactionAdapter>(adapter: A): A {
  const ours = (model: string) => model === MODEL;
  return {
    ...adapter,
    create: async (data) => {
      if (!ours(data.model)) return adapter.create(data);
      const created = await adapter.create({ ...data, data: hashedData(data.data) });
      return asNamed(created, CODE_FIELDS.map((field) => ({ field, value: (data.data as Record<string, unknown>)[field] as string })).filter(({ value }) => typeof value === "string"));
    },
    findOne: async (data) => (ours(data.model) ? asNamed(await adapter.findOne({ ...data, where: hashedWhere(data.where) }), data.where) : adapter.findOne(data)),
    findMany: async (data) => {
      if (!ours(data.model)) return adapter.findMany(data);
      const rows = await adapter.findMany({ ...data, where: hashedWhere(data.where) });
      return rows.map((row) => asNamed(row, data.where));
    },
    count: (data) => adapter.count(ours(data.model) ? { ...data, where: hashedWhere(data.where) } : data),
    update: async (data) =>
      ours(data.model) ? asNamed(await adapter.update({ ...data, where: hashedWhere(data.where), update: hashedData(data.update) }), data.where) : adapter.update(data),
    updateMany: (data) => adapter.updateMany(ours(data.model) ? { ...data, where: hashedWhere(data.where), update: hashedData(data.update) } : data),
    delete: (data) => adapter.delete(ours(data.model) ? { ...data, where: hashedWhere(data.where) } : data),
    deleteMany: (data) => adapter.deleteMany(ours(data.model) ? { ...data, where: hashedWhere(data.where) } : data),
    consumeOne: async (data) => (ours(data.model) ? asNamed(await adapter.consumeOne({ ...data, where: hashedWhere(data.where) }), data.where) : adapter.consumeOne(data)),
    incrementOne: async (data) =>
      ours(data.model) ? asNamed(await adapter.incrementOne({ ...data, where: hashedWhere(data.where) }), data.where) : adapter.incrementOne(data),
  } as A;
}

/** The database adapter, with the device flow's codes kept as their hashes. */
export function deviceCodesHashed(instance: AdapterInstance): AdapterInstance {
  return (options) => {
    const adapter = instance(options);
    return { ...hashing(adapter), transaction: (callback) => adapter.transaction((trx) => callback(hashing(trx))) };
  };
}
