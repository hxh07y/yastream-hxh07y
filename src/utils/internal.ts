import { randomUUID } from "node:crypto";

// Process-local token used only for trusted requests made by this server itself.
// It is generated at startup and is never exposed in responses or logs.
export const INTERNAL_REQUEST_TOKEN = randomUUID();
