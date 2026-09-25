// Fixture: a network import in packages/core.
import { request } from "node:https";

export const send: typeof request = request;
