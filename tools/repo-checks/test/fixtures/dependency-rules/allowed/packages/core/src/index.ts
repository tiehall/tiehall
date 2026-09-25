// Allowed: packages/core hashes with node:crypto, which does no I/O.
import { createHash } from "node:crypto";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
