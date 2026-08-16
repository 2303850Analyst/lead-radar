import "server-only";

import { canonicalJson, type CanonicalJsonValue } from "./hashing";
import { isCanonicalConceptId } from "./taxonomy";
import type { ConfirmationTokenClaims } from "./types";

const TOKEN_VERSION = 1 as const;
const DEFAULT_TTL_SECONDS = 10 * 60;
const MAX_TTL_SECONDS = 60 * 60;
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LENGTH = 8_192;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export type IssueConfirmationTokenInput = Omit<
  ConfirmationTokenClaims,
  "v" | "iat" | "exp" | "allowedConceptIds"
> & {
  allowedConceptIds: readonly string[];
  secret: string;
  now?: Date;
  ttlSeconds?: number;
};

export type VerifyConfirmationTokenOptions = {
  secret: string;
  now?: Date;
  expectedRequestCacheKey?: string;
  expectedTaxonomyVersion?: string;
  expectedProviderCatalogVersion?: string;
  expectedDecisionPolicyVersion?: string;
};

export class ConfirmationTokenError extends Error {
  readonly code:
    | "INVALID_CONFIRMATION_SECRET"
    | "MALFORMED_CONFIRMATION_TOKEN"
    | "INVALID_CONFIRMATION_SIGNATURE"
    | "EXPIRED_CONFIRMATION_TOKEN"
    | "CONFIRMATION_CONTEXT_MISMATCH";

  constructor(code: ConfirmationTokenError["code"], message: string) {
    super(message);
    this.name = "ConfirmationTokenError";
    this.code = code;
  }
}

function assertSecret(secret: string): Uint8Array {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.length < 32) {
    throw new ConfirmationTokenError(
      "INVALID_CONFIRMATION_SECRET",
      "SEARCH_PLAN_SIGNING_SECRET must contain at least 32 UTF-8 bytes",
    );
  }
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset];
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    const packed = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += BASE64URL_ALPHABET[(packed >>> 18) & 63];
    output += BASE64URL_ALPHABET[(packed >>> 12) & 63];
    if (second !== undefined) output += BASE64URL_ALPHABET[(packed >>> 6) & 63];
    if (third !== undefined) output += BASE64URL_ALPHABET[packed & 63];
  }
  return output;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new ConfirmationTokenError(
      "MALFORMED_CONFIRMATION_TOKEN",
      "Confirmation token contains invalid base64url",
    );
  }
  const bytes: number[] = [];
  for (let offset = 0; offset < value.length; offset += 4) {
    const chunk = value.slice(offset, offset + 4);
    const indexes = [...chunk].map((character) => BASE64URL_ALPHABET.indexOf(character));
    if (indexes.some((index) => index < 0)) {
      throw new ConfirmationTokenError(
        "MALFORMED_CONFIRMATION_TOKEN",
        "Confirmation token contains invalid base64url",
      );
    }
    const packed =
      (indexes[0] << 18) |
      ((indexes[1] ?? 0) << 12) |
      ((indexes[2] ?? 0) << 6) |
      (indexes[3] ?? 0);
    bytes.push((packed >>> 16) & 255);
    if (chunk.length >= 3) bytes.push((packed >>> 8) & 255);
    if (chunk.length >= 4) bytes.push(packed & 255);
  }
  return new Uint8Array(bytes);
}

async function hmacSha256(secret: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    secret.buffer.slice(
      secret.byteOffset,
      secret.byteOffset + secret.byteLength,
    ) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await globalThis.crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(message),
    ),
  );
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

function asCanonicalClaims(value: ConfirmationTokenClaims): CanonicalJsonValue {
  return value as unknown as CanonicalJsonValue;
}

function parseClaims(value: unknown): ConfirmationTokenClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfirmationTokenError(
      "MALFORMED_CONFIRMATION_TOKEN",
      "Confirmation token claims must be an object",
    );
  }
  const claims = value as Partial<ConfirmationTokenClaims>;
  const strings = [
    claims.requestCacheKey,
    claims.sourcePlanHash,
    claims.taxonomyVersion,
    claims.providerCatalogVersion,
    claims.decisionPolicyVersion,
  ];
  if (
    claims.v !== TOKEN_VERSION ||
    strings.some((item) => typeof item !== "string" || !item) ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    !Array.isArray(claims.allowedConceptIds) ||
    claims.allowedConceptIds.length < 1 ||
    claims.allowedConceptIds.length > 3 ||
    new Set(claims.allowedConceptIds).size !== claims.allowedConceptIds.length ||
    claims.allowedConceptIds.some(
      (conceptId) => typeof conceptId !== "string" || !isCanonicalConceptId(conceptId),
    )
  ) {
    throw new ConfirmationTokenError(
      "MALFORMED_CONFIRMATION_TOKEN",
      "Confirmation token claims are invalid",
    );
  }
  return claims as ConfirmationTokenClaims;
}

export async function issueConfirmationToken(
  input: IssueConfirmationTokenInput,
): Promise<{ token: string; claims: ConfirmationTokenClaims; expiresAt: string }> {
  const secret = assertSecret(input.secret);
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`ttlSeconds must be between 1 and ${MAX_TTL_SECONDS}`);
  }
  const allowedConceptIds = [...new Set(input.allowedConceptIds)].sort();
  if (
    !allowedConceptIds.length ||
    allowedConceptIds.length > 3 ||
    allowedConceptIds.some((conceptId) => !isCanonicalConceptId(conceptId))
  ) {
    throw new Error("allowedConceptIds must contain one to three canonical IDs");
  }
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  const claims: ConfirmationTokenClaims = {
    v: TOKEN_VERSION,
    requestCacheKey: input.requestCacheKey,
    sourcePlanHash: input.sourcePlanHash,
    allowedConceptIds,
    taxonomyVersion: input.taxonomyVersion,
    providerCatalogVersion: input.providerCatalogVersion,
    decisionPolicyVersion: input.decisionPolicyVersion,
    iat,
    exp: iat + ttlSeconds,
  };
  const claimsPart = encodeBase64Url(
    new TextEncoder().encode(canonicalJson(asCanonicalClaims(claims))),
  );
  const signature = await hmacSha256(secret, claimsPart);
  return {
    token: `${claimsPart}.${encodeBase64Url(signature)}`,
    claims,
    expiresAt: new Date(claims.exp * 1_000).toISOString(),
  };
}

export async function verifyConfirmationToken(
  token: string,
  options: VerifyConfirmationTokenOptions,
): Promise<ConfirmationTokenClaims> {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    throw new ConfirmationTokenError(
      "MALFORMED_CONFIRMATION_TOKEN",
      "Confirmation token is malformed",
    );
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new ConfirmationTokenError(
      "MALFORMED_CONFIRMATION_TOKEN",
      "Confirmation token is malformed",
    );
  }
  const secret = assertSecret(options.secret);
  const presentedSignature = decodeBase64Url(parts[1]);
  const expectedSignature = await hmacSha256(secret, parts[0]);
  if (!constantTimeEqual(presentedSignature, expectedSignature)) {
    throw new ConfirmationTokenError(
      "INVALID_CONFIRMATION_SIGNATURE",
      "Confirmation token signature is invalid",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
  } catch (error) {
    if (error instanceof ConfirmationTokenError) throw error;
    throw new ConfirmationTokenError(
      "MALFORMED_CONFIRMATION_TOKEN",
      "Confirmation token claims are not valid JSON",
    );
  }
  const claims = parseClaims(parsed);
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  if (
    claims.exp <= nowSeconds ||
    claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > MAX_TTL_SECONDS
  ) {
    throw new ConfirmationTokenError(
      "EXPIRED_CONFIRMATION_TOKEN",
      "Confirmation token is expired or outside its valid time window",
    );
  }

  const mismatched =
    (options.expectedRequestCacheKey !== undefined &&
      claims.requestCacheKey !== options.expectedRequestCacheKey) ||
    (options.expectedTaxonomyVersion !== undefined &&
      claims.taxonomyVersion !== options.expectedTaxonomyVersion) ||
    (options.expectedProviderCatalogVersion !== undefined &&
      claims.providerCatalogVersion !== options.expectedProviderCatalogVersion) ||
    (options.expectedDecisionPolicyVersion !== undefined &&
      claims.decisionPolicyVersion !== options.expectedDecisionPolicyVersion);
  if (mismatched) {
    throw new ConfirmationTokenError(
      "CONFIRMATION_CONTEXT_MISMATCH",
      "Confirmation token does not match the current planner context",
    );
  }
  return claims;
}

export function searchPlanSigningSecretFromEnv(): string | null {
  const value = process.env.SEARCH_PLAN_SIGNING_SECRET?.trim();
  return value || null;
}
