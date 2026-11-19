import { uuidv7 } from "uuidv7";
import { getOrigin } from "./domain.js";

type VerificationStatus = "waiting" | "open_requested" | "completed" | "expired";

interface OuoVerification {
  status: VerificationStatus;
  openRequested: boolean;
  expiresAt: number;
}

const verifications = new Map<string, OuoVerification>();
const ACTIVE_TTL_MS = 10 * 60 * 1000;
const COMPLETED_TTL_MS = 5 * 60 * 1000;

function getActive(id: string) {
  const verification = verifications.get(id);
  if (!verification) return undefined;
  if (Date.now() >= verification.expiresAt) {
    verifications.delete(id);
    return undefined;
  }
  return verification;
}

export function createOuoVerification() {
  const id = uuidv7();
  verifications.set(id, {
    status: "waiting",
    openRequested: false,
    expiresAt: Date.now() + ACTIVE_TTL_MS,
  });
  return {
    id,
    pageUrl: new URL(`/verify/${id}`, getOrigin()).toString(),
  };
}

export function requestOuoVerificationOpen(id: string) {
  const verification = getActive(id);
  if (!verification || verification.status === "completed") return false;
  verification.openRequested = true;
  verification.status = "open_requested";
  return true;
}

export function consumeOuoVerificationOpenRequest(id: string) {
  const verification = getActive(id);
  if (!verification || !verification.openRequested) return false;
  verification.openRequested = false;
  return true;
}

export function getOuoVerificationStatus(id: string) {
  return getActive(id)?.status ?? "expired";
}

export function completeOuoVerification(id: string) {
  const verification = verifications.get(id);
  if (!verification) return;
  verification.status = "completed";
  verification.openRequested = false;
  verification.expiresAt = Date.now() + COMPLETED_TTL_MS;
}

export function expireOuoVerification(id: string) {
  const verification = verifications.get(id);
  if (!verification || verification.status === "completed") return;
  verification.status = "expired";
  verification.openRequested = false;
  verification.expiresAt = Date.now() + 60_000;
}
