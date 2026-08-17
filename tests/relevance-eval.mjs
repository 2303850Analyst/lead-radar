import { evaluateRelevanceCorpus } from "./helpers/relevance-evaluation.mjs";

const report = await evaluateRelevanceCorpus();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.decision !== "PASS") process.exitCode = 1;
