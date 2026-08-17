import { evaluateOpenWorldCorpus } from "./helpers/open-world-evaluation.mjs";

const report = await evaluateOpenWorldCorpus();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.decision !== "PASS") process.exitCode = 1;
