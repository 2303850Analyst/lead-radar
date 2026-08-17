import Ajv, { type ErrorObject } from "ajv";

import semanticIntentSchemaArtifact from "./kimi-semantic-intent.schema.json";
import type { SemanticIntentV2 } from "./types";

type JsonSchema = Record<string, unknown>;

export const KIMI_SEMANTIC_INTENT_SCHEMA = semanticIntentSchemaArtifact as JsonSchema;

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSemanticIntentArtifact = ajv.compile(KIMI_SEMANTIC_INTENT_SCHEMA);

const MAX_SEMANTIC_INTENT_JSON_CHARS = 30_000;
const FORBIDDEN_EXECUTABLE_VALUE =
  /(?:(?:https?|ftp|file|mailto|geo|tel|javascript|data|ws|wss):|\/\/[a-z0-9]|www\.|(?:^|\s)(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\/v\d+\/[a-z0-9/_-]*\?|(?:^|[?&\s])(?:api_?key|filter|bias|categories?|type|lat|lon|radius)\s*[:=]|[-+]?\d{1,3}\.\d+\s*[,;\s]\s*[-+]?\d{1,3}\.\d+)/i;

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

export function validateKimiSemanticIntent(value: unknown): SemanticIntentV2 {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new KimiSchemaValidationError([`response cannot be serialized: ${String(error)}`]);
  }
  if (serialized.length > MAX_SEMANTIC_INTENT_JSON_CHARS) {
    throw new KimiSchemaValidationError(["response exceeds the semantic intent size limit"]);
  }
  if (!validateSemanticIntentArtifact(value)) {
    throw new KimiSchemaValidationError(
      formatAjvErrors(validateSemanticIntentArtifact.errors),
    );
  }
  const intent = value as SemanticIntentV2;
  const issues: string[] = [];
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
