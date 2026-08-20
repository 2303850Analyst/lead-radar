import Ajv, { type ErrorObject } from "ajv";

import semanticIntentSchemaArtifact from "./kimi-semantic-intent.schema.json";
import semanticIntentTransportSchemaArtifact from "./kimi-semantic-intent.transport.schema.json";
import type { SemanticIntentV2 } from "./types";

type JsonSchema = Record<string, unknown>;

export const KIMI_SEMANTIC_INTENT_SCHEMA = semanticIntentSchemaArtifact as JsonSchema;
export const KIMI_SEMANTIC_INTENT_TRANSPORT_SCHEMA =
  semanticIntentTransportSchemaArtifact as JsonSchema;

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSemanticIntentArtifact = ajv.compile(KIMI_SEMANTIC_INTENT_SCHEMA);

const MAX_SEMANTIC_INTENT_JSON_CHARS = 30_000;
const MAX_TERM_CHARS = 120;
const SEMANTIC_TERM_ARRAY_FIELDS = Object.freeze([
  "industries",
  "coreBusinessTypes",
  "adjacentBusinessTypes",
  "excludedBusinessTypes",
  "productsAndServices",
  "includeSignals",
  "excludeSignals",
] as const);
const RETRIEVAL_TERM_ARRAY_FIELDS = Object.freeze([
  "precision",
  "recall",
  "exclude",
] as const);
const FORBIDDEN_EXECUTABLE_VALUE =
  /(?:(?:https?|ftp|file|mailto|geo|tel|javascript|data|ws|wss):|\/\/[a-z0-9]|www\.|(?:^|\s)(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\/v\d+\/[a-z0-9/_-]*\?|(?:^|[?&\s])(?:api_?key|filter|bias|categories?|type|lat|lon|radius)\s*[:=]|(?:^|\s)[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+(?:$|\s)|[-+]?\d{1,3}\.\d+\s*[,;\s]\s*[-+]?\d{1,3}\.\d+)/i;

export class KimiSchemaValidationError extends Error {
  readonly code = "KIMI_SCHEMA_VALIDATION_FAILED";
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Kimi response failed validation: ${issues.join("; ")}`);
    this.name = "KimiSchemaValidationError";
    this.issues = issues;
  }
}

function semanticIntentStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(semanticIntentStrings);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(semanticIntentStrings);
  }
  return [];
}

function assertSemanticIntentEnvelope(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new KimiSchemaValidationError([`response cannot be serialized: ${String(error)}`]);
  }
  if (typeof serialized !== "string") {
    throw new KimiSchemaValidationError(["response must be a JSON value"]);
  }
  if (serialized.length > MAX_SEMANTIC_INTENT_JSON_CHARS) {
    throw new KimiSchemaValidationError(["response exceeds the semantic intent size limit"]);
  }
}

function assertNoExecutableSemanticValues(value: unknown): void {
  if (semanticIntentStrings(value).some((item) => FORBIDDEN_EXECUTABLE_VALUE.test(item))) {
    throw new KimiSchemaValidationError([
      "semantic intent must not contain URLs, coordinates, or provider parameters",
    ]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalTerm(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function canonicalTermArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const normalized = value.map((item) =>
    typeof item === "string" ? canonicalTerm(item) : item,
  );
  if (
    !normalized.every(
      (item) =>
        typeof item === "string" &&
        item.length >= 1 &&
        item.length <= MAX_TERM_CHARS,
    )
  ) {
    return normalized;
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of normalized) {
    const key = item.toLocaleLowerCase("ru-RU");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function canonicalizeSemanticIntentArrays(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const canonical: Record<string, unknown> = { ...value };
  for (const field of SEMANTIC_TERM_ARRAY_FIELDS) {
    if (Object.hasOwn(canonical, field)) {
      canonical[field] = canonicalTermArray(canonical[field]);
    }
  }
  if (isRecord(canonical.retrievalTerms)) {
    const retrievalTerms: Record<string, unknown> = {
      ...canonical.retrievalTerms,
    };
    for (const field of RETRIEVAL_TERM_ARRAY_FIELDS) {
      if (Object.hasOwn(retrievalTerms, field)) {
        retrievalTerms[field] = canonicalTermArray(retrievalTerms[field]);
      }
    }
    canonical.retrievalTerms = retrievalTerms;
  }
  return canonical;
}

export function parseKimiSemanticIntent(value: unknown): SemanticIntentV2 {
  assertSemanticIntentEnvelope(value);
  // Scan the complete response before canonicalizing any open-vocabulary
  // array, so normalization can never hide an executable value.
  assertNoExecutableSemanticValues(value);
  return validateKimiSemanticIntent(canonicalizeSemanticIntentArrays(value));
}

export function validateKimiSemanticIntent(value: unknown): SemanticIntentV2 {
  assertSemanticIntentEnvelope(value);
  if (!validateSemanticIntentArtifact(value)) {
    throw new KimiSchemaValidationError(
      formatAjvErrors(validateSemanticIntentArtifact.errors),
    );
  }
  const intent = value as SemanticIntentV2;
  const issues: string[] = [];
  const permitsEmptyPositiveTerms =
    intent.ambiguity.isAmbiguous ||
    (intent.entityKind === "non_physical" &&
      intent.physicalLocationRequirement === "not_applicable");
  if (
    (intent.ambiguity.isAmbiguous &&
      (!intent.ambiguity.reason || !intent.ambiguity.clarificationQuestion)) ||
    (!intent.ambiguity.isAmbiguous &&
      (intent.ambiguity.reason !== null ||
        intent.ambiguity.clarificationQuestion !== null))
  ) {
    issues.push(
      "ambiguity requires both a reason and clarificationQuestion, or neither",
    );
  }
  if (
    intent.entityKind === "non_physical" &&
    intent.physicalLocationRequirement !== "not_applicable"
  ) {
    issues.push("non_physical intent must use not_applicable location requirement");
  }
  if (
    !permitsEmptyPositiveTerms &&
    (intent.coreBusinessTypes.length === 0 ||
      intent.retrievalTerms.precision.length === 0)
  ) {
    issues.push(
      "non-ambiguous physical intent requires coreBusinessTypes and precision retrieval terms",
    );
  }
  if (
    !permitsEmptyPositiveTerms &&
    ![
      ...intent.retrievalTerms.precision,
      ...intent.retrievalTerms.recall,
    ].some((term) => /[a-z]/i.test(term))
  ) {
    issues.push(
      "retrieval terms must include at least one provider-neutral English equivalent",
    );
  }
  if (semanticIntentStrings(intent).some((item) => FORBIDDEN_EXECUTABLE_VALUE.test(item))) {
    issues.push("semantic intent must not contain URLs, coordinates, or provider parameters");
  }
  if (issues.length) throw new KimiSchemaValidationError(issues);
  return intent;
}

function formatAjvErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  );
}
