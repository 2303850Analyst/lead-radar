import type {
  LeadRelevance,
  RelevanceEvidenceField,
  RelevanceEvidenceFact,
} from "../types";
import type { SemanticIntentV2 } from "./types";

export const RELEVANCE_STATUSES = [
  "matched",
  "maybe",
  "rejected",
  "not_checked",
] as const;

export const RELEVANCE_CONTRACT_VERSION = "2026-08-17.2";
export const CANDIDATE_EVIDENCE_SCHEMA_VERSION = "candidate-evidence-v2";

export const RELEVANCE_EVIDENCE_FIELDS = [
  "name",
  "providerCategoryIds",
  "locality",
  "sourceDescription",
] as const;

export type CandidateEvidence = {
  candidateId: string;
  name: string | null;
  providerCategoryIds: string[];
  locality: string | null;
  sourceDescription: string | null;
};

export type CandidateRelevanceContext = {
  semanticIntent: SemanticIntentV2;
  precisionCategoryIds: readonly string[];
  broadCategoryIds: readonly string[];
  exclusionTerms: readonly string[];
};

export type RelevanceClassifierInput = {
  semanticIntent: SemanticIntentV2;
  candidates: CandidateEvidence[];
};

export type RelevanceClassifier = {
  classify(
    input: RelevanceClassifierInput,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

const GENERIC_TOKENS = new Set([
  "business",
  "company",
  "find",
  "place",
  "service",
  "services",
  "бизнес",
  "компания",
  "место",
  "найти",
  "организация",
  "услуга",
  "услуги",
  "центр",
]);

const MAX_EVIDENCE_FACTS = 8;
const MAX_REASON_CODES = 12;
const KIMI_RELEVANCE_REASON_CODES = new Set([
  "MODEL_MATCH",
  "MODEL_PARTIAL_MATCH",
  "MODEL_REJECT",
  "MODEL_INSUFFICIENT_EVIDENCE",
]);
const KIMI_REASON_CODE_BY_STATUS: Record<LeadRelevance["status"], string> = {
  matched: "MODEL_MATCH",
  maybe: "MODEL_PARTIAL_MATCH",
  rejected: "MODEL_REJECT",
  not_checked: "MODEL_INSUFFICIENT_EVIDENCE",
};
const CLASSIFIER_RESULT_KEYS = new Set([
  "candidateId",
  "status",
  "confidence",
  "evidence",
  "reasonCodes",
  "source",
]);
const EVIDENCE_FACT_KEYS = new Set(["field", "value"]);

function hasExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/[._/\\-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function significantTokens(term: string): string[] {
  return normalize(term)
    .split(" ")
    .filter(
      (token) =>
        token.length >= 3 &&
        !GENERIC_TOKENS.has(token),
    );
}

function textContainsTerm(value: string | null, term: string): boolean {
  if (!value) return false;
  const tokens = significantTokens(term);
  if (!tokens.length) return false;
  const normalizedValue = ` ${normalize(value)} `;
  return tokens.every((token) => normalizedValue.includes(` ${token} `));
}

function categoryMatchesTarget(candidateId: string, targetId: string): boolean {
  return (
    candidateId === targetId ||
    candidateId.startsWith(`${targetId}.`)
  );
}

function dedupeFacts(facts: RelevanceEvidenceFact[]): RelevanceEvidenceFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.field}\u001f${fact.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_EVIDENCE_FACTS);
}

function evidenceForTerm(
  evidence: CandidateEvidence,
  term: string,
): RelevanceEvidenceFact[] {
  const facts: RelevanceEvidenceFact[] = [];
  if (textContainsTerm(evidence.name, term) && evidence.name) {
    facts.push({ field: "name", value: evidence.name });
  }
  if (
    textContainsTerm(evidence.sourceDescription, term) &&
    evidence.sourceDescription
  ) {
    facts.push({
      field: "sourceDescription",
      value: evidence.sourceDescription,
    });
  }
  for (const categoryId of evidence.providerCategoryIds) {
    if (textContainsTerm(categoryId, term)) {
      facts.push({ field: "providerCategoryIds", value: categoryId });
    }
  }
  return facts;
}

function result(
  candidateId: string,
  status: LeadRelevance["status"],
  confidence: number | null,
  evidence: RelevanceEvidenceFact[],
  reasonCodes: string[],
  source: LeadRelevance["source"] = "deterministic",
): LeadRelevance {
  return {
    candidateId,
    status,
    confidence,
    evidence: dedupeFacts(evidence),
    reasonCodes: [...new Set(reasonCodes)].slice(0, MAX_REASON_CODES),
    source,
  };
}

export function notCheckedRelevance(
  candidateId: string,
  reasonCode = "INSUFFICIENT_EVIDENCE",
): LeadRelevance {
  return result(
    candidateId,
    "not_checked",
    null,
    [],
    [reasonCode],
    "not_checked",
  );
}

function positiveTerms(intent: SemanticIntentV2): string[] {
  return [
    ...intent.coreBusinessTypes,
    ...intent.productsAndServices,
    ...intent.includeSignals,
    ...intent.retrievalTerms.precision,
    ...intent.retrievalTerms.recall,
  ];
}

export function classifyCandidateRelevance(
  evidence: CandidateEvidence,
  context: CandidateRelevanceContext,
): LeadRelevance {
  const exclusions = [
    ...context.exclusionTerms,
    ...context.semanticIntent.excludedBusinessTypes,
    ...context.semanticIntent.excludeSignals,
    ...context.semanticIntent.retrievalTerms.exclude,
  ];
  const exclusionFacts = dedupeFacts(
    exclusions.flatMap((term) => evidenceForTerm(evidence, term)),
  );
  if (exclusionFacts.length) {
    return result(
      evidence.candidateId,
      "rejected",
      0.98,
      exclusionFacts,
      ["EXCLUSION_MATCH"],
    );
  }

  const precisionCategoryFacts = evidence.providerCategoryIds
    .filter((candidateId) =>
      context.precisionCategoryIds.some((targetId) =>
        categoryMatchesTarget(candidateId, targetId),
      ),
    )
    .map((categoryId) => ({
      field: "providerCategoryIds" as const,
      value: categoryId,
    }));
  const broadCategoryFacts = evidence.providerCategoryIds
    .filter((candidateId) =>
      context.broadCategoryIds.some((targetId) =>
        categoryMatchesTarget(candidateId, targetId),
      ),
    )
    .map((categoryId) => ({
      field: "providerCategoryIds" as const,
      value: categoryId,
    }));
  const termFacts = dedupeFacts(
    positiveTerms(context.semanticIntent).flatMap((term) =>
      evidenceForTerm(evidence, term),
    ),
  );
  const textTermFields = new Set(
    termFacts
      .filter((fact) => fact.field !== "providerCategoryIds")
      .map((fact) => fact.field),
  );

  if (precisionCategoryFacts.length) {
    return result(
      evidence.candidateId,
      "matched",
      0.95,
      [...precisionCategoryFacts, ...broadCategoryFacts, ...termFacts],
      [
        "PROVIDER_CATEGORY_MATCH",
        ...(textTermFields.size ? ["TEXT_SIGNAL_MATCH"] : []),
      ],
    );
  }
  if (
    (broadCategoryFacts.length && textTermFields.size >= 1) ||
    textTermFields.size >= 2
  ) {
    return result(
      evidence.candidateId,
      "matched",
      0.86,
      [...broadCategoryFacts, ...termFacts],
      ["MULTIPLE_EVIDENCE_MATCH"],
    );
  }
  if (broadCategoryFacts.length || termFacts.length) {
    return result(
      evidence.candidateId,
      "maybe",
      0.64,
      [...broadCategoryFacts, ...termFacts],
      ["PARTIAL_EVIDENCE_MATCH"],
    );
  }
  if (evidence.providerCategoryIds.length) {
    return result(
      evidence.candidateId,
      "rejected",
      0.8,
      evidence.providerCategoryIds.slice(0, MAX_EVIDENCE_FACTS).map(
        (categoryId) => ({
          field: "providerCategoryIds",
          value: categoryId,
        }),
      ),
      ["PROVIDER_CATEGORY_CONFLICT"],
    );
  }
  return notCheckedRelevance(evidence.candidateId);
}

function evidenceValueExists(
  evidence: CandidateEvidence,
  field: RelevanceEvidenceField,
  value: string,
): boolean {
  if (field === "providerCategoryIds") {
    return evidence.providerCategoryIds.includes(value);
  }
  return evidence[field] === value;
}

/**
 * Runtime trust boundary for any optional classifier. Invalid evidence cannot
 * become a fact on a lead and degrades to a visible, retained not_checked card.
 */
export function validateCandidateRelevance(
  evidence: CandidateEvidence,
  value: unknown,
): LeadRelevance {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return notCheckedRelevance(evidence.candidateId, "INVALID_CLASSIFIER_RESULT");
  }
  if (!hasExactKeys(value as Record<string, unknown>, CLASSIFIER_RESULT_KEYS)) {
    return notCheckedRelevance(evidence.candidateId, "INVALID_CLASSIFIER_RESULT");
  }
  const candidate = value as Partial<LeadRelevance>;
  if (
    candidate.candidateId !== evidence.candidateId ||
    !RELEVANCE_STATUSES.includes(candidate.status as (typeof RELEVANCE_STATUSES)[number]) ||
    candidate.source !== "kimi" ||
    (candidate.confidence !== null &&
      (typeof candidate.confidence !== "number" ||
        !Number.isFinite(candidate.confidence) ||
        candidate.confidence < 0 ||
        candidate.confidence > 1)) ||
    !Array.isArray(candidate.evidence) ||
    candidate.evidence.length > MAX_EVIDENCE_FACTS ||
    !Array.isArray(candidate.reasonCodes) ||
    candidate.reasonCodes.length !== 1 ||
    candidate.reasonCodes.some(
      (code) =>
        typeof code !== "string" || !KIMI_RELEVANCE_REASON_CODES.has(code),
    )
  ) {
    return notCheckedRelevance(evidence.candidateId, "INVALID_CLASSIFIER_RESULT");
  }

  if (
    candidate.reasonCodes[0] !==
    KIMI_REASON_CODE_BY_STATUS[candidate.status as LeadRelevance["status"]]
  ) {
    return notCheckedRelevance(evidence.candidateId, "INVALID_CLASSIFIER_RESULT");
  }

  const validFacts: RelevanceEvidenceFact[] = [];
  for (const fact of candidate.evidence) {
    if (
      !fact ||
      typeof fact !== "object" ||
      Array.isArray(fact) ||
      !hasExactKeys(fact as Record<string, unknown>, EVIDENCE_FACT_KEYS) ||
      !RELEVANCE_EVIDENCE_FIELDS.includes(
        (fact as RelevanceEvidenceFact).field,
      ) ||
      typeof (fact as RelevanceEvidenceFact).value !== "string" ||
      !evidenceValueExists(
        evidence,
        (fact as RelevanceEvidenceFact).field,
        (fact as RelevanceEvidenceFact).value,
      )
    ) {
      return notCheckedRelevance(evidence.candidateId, "INVALID_EVIDENCE");
    }
    const canonicalFact = fact as RelevanceEvidenceFact;
    validFacts.push({
      field: canonicalFact.field,
      value: canonicalFact.value,
    });
  }
  if (candidate.status !== "not_checked" && !validFacts.length) {
    return notCheckedRelevance(evidence.candidateId, "MISSING_EVIDENCE");
  }
  const status = candidate.status as LeadRelevance["status"];
  return result(
    evidence.candidateId,
    status,
    candidate.confidence,
    validFacts,
    candidate.reasonCodes,
    "kimi",
  );
}
