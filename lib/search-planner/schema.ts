import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

import schemaArtifact from "./kimi-resolution.schema.json";
import { CANONICAL_CONCEPT_IDS, isCanonicalConceptId } from "./taxonomy";
import type { KimiResolution } from "./types";

type JsonSchema = Record<string, unknown>;

export const KIMI_RESOLUTION_SCHEMA = schemaArtifact as JsonSchema;

const ajv = new Ajv({ allErrors: true, strict: true });
const validateArtifact = ajv.compile(KIMI_RESOLUTION_SCHEMA);

export class KimiSchemaValidationError extends Error {
  readonly code = "KIMI_SCHEMA_VALIDATION_FAILED";
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Kimi response failed validation: ${issues.join("; ")}`);
    this.name = "KimiSchemaValidationError";
    this.issues = issues;
  }
}

function formatAjvErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  );
}

function conceptEnum(schema: JsonSchema): string[] {
  const definitions = schema.definitions as Record<string, unknown> | undefined;
  const conceptId = definitions?.conceptId as Record<string, unknown> | undefined;
  return Array.isArray(conceptId?.enum)
    ? conceptId.enum.filter((value): value is string => typeof value === "string")
    : [];
}

export function assertSchemaTaxonomyParity(): void {
  const taxonomyIds = [...CANONICAL_CONCEPT_IDS].sort();
  const schemaIds = conceptEnum(KIMI_RESOLUTION_SCHEMA).sort();
  if (
    taxonomyIds.length !== schemaIds.length ||
    taxonomyIds.some((conceptId, index) => conceptId !== schemaIds[index])
  ) {
    throw new Error("Kimi JSON Schema concept enum is out of sync with the taxonomy");
  }
}

assertSchemaTaxonomyParity();

/**
 * Returns a schema whose concept enum is narrowed to the candidates sent in
 * this exact model call. The checked-in JSON artifact remains the source of
 * truth for shape and the complete taxonomy enum.
 */
export function createKimiResolutionSchema(
  allowedConceptIds: readonly string[],
): JsonSchema {
  const uniqueIds = [...new Set(allowedConceptIds)];
  if (!uniqueIds.length || uniqueIds.some((conceptId) => !isCanonicalConceptId(conceptId))) {
    throw new Error("Kimi candidate IDs must be a non-empty canonical subset");
  }
  const narrowed = JSON.parse(JSON.stringify(KIMI_RESOLUTION_SCHEMA)) as JsonSchema;
  delete narrowed.$id;
  const definitions = narrowed.definitions as Record<string, JsonSchema>;
  definitions.conceptId.enum = uniqueIds;
  return narrowed;
}

function semanticIssues(
  resolution: KimiResolution,
  allowedConceptIds: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  const referencedIds = [
    ...resolution.selectedConceptIds,
    ...resolution.alternatives.map((alternative) => alternative.conceptId),
  ];
  if (referencedIds.some((conceptId) => !allowedConceptIds.has(conceptId))) {
    issues.push("response references a concept outside the supplied candidate set");
  }

  const alternativeIds = resolution.alternatives.map(
    (alternative) => alternative.conceptId,
  );
  if (new Set(alternativeIds).size !== alternativeIds.length) {
    issues.push("alternatives must not repeat a concept");
  }
  if (
    resolution.selectedConceptIds.some((conceptId) => alternativeIds.includes(conceptId))
  ) {
    issues.push("selected concept must not also appear in alternatives");
  }

  if (resolution.status === "selected" && resolution.selectedConceptIds.length !== 1) {
    issues.push("selected status requires exactly one selectedConceptId");
  }
  if (resolution.status !== "selected" && resolution.selectedConceptIds.length !== 0) {
    issues.push(`${resolution.status} status requires an empty selectedConceptIds array`);
  }
  if (resolution.status === "ambiguous" && resolution.alternatives.length < 2) {
    issues.push("ambiguous status requires at least two alternatives");
  }
  if (
    resolution.status === "unsupported" &&
    !resolution.clarificationReasonCode
  ) {
    issues.push("unsupported status requires a clarificationReasonCode");
  }
  return issues;
}

export function validateKimiResolution(
  value: unknown,
  allowedConceptIds: readonly string[],
): KimiResolution {
  if (!validateArtifact(value)) {
    throw new KimiSchemaValidationError(formatAjvErrors(validateArtifact.errors));
  }
  const resolution = value as KimiResolution;
  const issues = semanticIssues(resolution, new Set(allowedConceptIds));
  if (issues.length) throw new KimiSchemaValidationError(issues);
  return resolution;
}

export function compileKimiResolutionValidator(
  allowedConceptIds: readonly string[],
): ValidateFunction<KimiResolution> {
  const localAjv = new Ajv({ allErrors: true, strict: true });
  return localAjv.compile<KimiResolution>(
    createKimiResolutionSchema(allowedConceptIds),
  );
}
