import { uuidv7 } from "uuidv7";
import { getOrigin } from "./domain.js";

type VerificationStatus =
  | "preparing"
  | "awaiting_verification"
  | "open_requested"
  | "completed"
  | "expired";

interface OuoVerification {
  id: string;
  providerContentId: string;
  status: VerificationStatus;
  openRequested: boolean;
  expiresAt: number;
}

const verifications = new Map<string, OuoVerification>();
const contentSessions = new Map<string, string>();
const ACTIVE_TTL_MS = 60 * 60 * 1000;
const COMPLETED_TTL_MS = 5 * 60 * 1000;

function getActive(id: string) {
  const verification = verifications.get(id);
  if (!verification) return undefined;
  if (Date.now() >= verification.expiresAt) {
    verifications.delete(id);
    if (contentSessions.get(verification.providerContentId) === id) {
      contentSessions.delete(verification.providerContentId);
    }
    return undefined;
  }
  return verification;
}

export function getOrCreateOuoVerification(providerContentId: string) {
  const existingId = contentSessions.get(providerContentId);
  if (existingId) {
    const existing = getActive(existingId);
    if (existing && existing.status !== "completed") {
      return {
        id: existing.id,
        pageUrl: new URL(`/verify/${existing.id}`, getOrigin()).toString(),
      };
    }
  }

  const id = uuidv7();
  const verification: OuoVerification = {
    id,
    providerContentId,
    status: "preparing",
    openRequested: false,
    expiresAt: Date.now() + ACTIVE_TTL_MS,
  };
  verifications.set(id, verification);
  contentSessions.set(providerContentId, id);
  return {
    id,
    pageUrl: new URL(`/verify/${id}`, getOrigin()).toString(),
  };
}

export function getOuoVerificationForContent(providerContentId: string) {
  const id = contentSessions.get(providerContentId);
  if (!id) return undefined;
  const verification = getActive(id);
  if (!verification || verification.status === "completed") return undefined;
  return {
    id,
    pageUrl: new URL(`/verify/${id}`, getOrigin()).toString(),
    status: verification.status,
  };
}

export function markOuoVerificationRequired(providerContentId: string) {
  const active = getOuoVerificationForContent(providerContentId);
  if (!active) return;
  const verification = getActive(active.id);
  if (verification && verification.status !== "open_requested") {
    verification.status = "awaiting_verification";
  }
}

export function requestOuoVerificationOpen(id: string) {
  const verification = getActive(id);
  if (!verification || verification.status !== "awaiting_verification") {
    return false;
  }
  verification.openRequested = true;
  verification.status = "open_requested";
  return true;
}

export function consumeOuoVerificationOpenRequest(id: string) {
  const verification = getActive(id);
  if (!verification || !verification.openRequested) return false;
  verification.openRequested = false;
  verification.status = "awaiting_verification";
  return true;
}

export function getOuoVerificationStatus(id: string) {
  return getActive(id)?.status ?? "expired";
}

export function completeOuoVerificationForContent(providerContentId: string) {
  const id = contentSessions.get(providerContentId);
  if (!id) return;
  const verification = verifications.get(id);
  if (!verification) return;
  verification.status = "completed";
  verification.openRequested = false;
  verification.expiresAt = Date.now() + COMPLETED_TTL_MS;
  contentSessions.delete(providerContentId);
}

export function expireOuoVerification(id: string) {
  const verification = verifications.get(id);
  if (!verification || verification.status === "completed") return;
  verification.status = "expired";
  verification.openRequested = false;
  verification.expiresAt = Date.now() + 60_000;
  if (contentSessions.get(verification.providerContentId) === id) {
    contentSessions.delete(verification.providerContentId);
  }
}
