export function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

export function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return sorted[index];
}

export function confusionMetrics(expectedLabels, actualLabels, labels) {
  const perLabel = Object.fromEntries(
    labels.map((label) => {
      let truePositive = 0;
      let falsePositive = 0;
      let falseNegative = 0;
      for (let index = 0; index < expectedLabels.length; index += 1) {
        const expected = expectedLabels[index];
        const actual = actualLabels[index];
        if (expected === label && actual === label) truePositive += 1;
        else if (expected !== label && actual === label) falsePositive += 1;
        else if (expected === label && actual !== label) falseNegative += 1;
      }
      const precision = ratio(truePositive, truePositive + falsePositive) ?? 0;
      const recall = ratio(truePositive, truePositive + falseNegative) ?? 0;
      const f1 =
        precision + recall === 0
          ? 0
          : (2 * precision * recall) / (precision + recall);
      return [
        label,
        { truePositive, falsePositive, falseNegative, precision, recall, f1 },
      ];
    }),
  );
  const macroF1 =
    labels.reduce((sum, label) => sum + perLabel[label].f1, 0) / labels.length;
  return { perLabel, macroF1 };
}

export function roundMetric(value, digits = 4) {
  if (value === null || value === undefined) return null;
  return Number(value.toFixed(digits));
}

export function assertAggregateOnly(report) {
  const serialized = JSON.stringify(report);
  const forbiddenPatterns = [
    /MOONSHOT_API_KEY/i,
    /apiKey=/i,
    /sk-[A-Za-z0-9_-]{12,}/,
    /\+\d[\d ()-]{8,}/,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  ];
  return forbiddenPatterns.every((pattern) => !pattern.test(serialized));
}
