import assert from "node:assert/strict";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const [baselineRoot, candidateRoot, outputPath] = process.argv.slice(2);
assert(baselineRoot && candidateRoot && outputPath, "Expected baseline, candidate, and result paths");

const sourceCommit = "d05c9257eb3fad3a4616cf01f735c32cc33cfb73";
const recordedWorkflowCommit = "9460884b2bf476468d2cae368a32605661104eb5";
const expectedRevisions = {
  baseline: "08650ab9d3bf95a0c585581b8bd63eb7b8315264",
  candidate: "3f4022aa98b7eaa33d88300c6185ddc06a664434",
};
const readJSON = (root, path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const readText = (root, path) => readFileSync(join(root, path), "utf8");
const nonRCodesignPins = (lock) => lock.pins
  .filter((pin) => pin.identity !== "swift-rcodesign")
  .sort((left, right) => left.identity.localeCompare(right.identity));

const recorded = {};
for (const [variant, root] of [["baseline", baselineRoot], ["candidate", candidateRoot]]) {
  const provenance = readJSON(root, "_temp/native-provenance.json");
  assert.equal(provenance.sourceCommit, sourceCommit);
  assert.equal(provenance.workflowCommit, recordedWorkflowCommit);
  assert.equal(provenance.rcodesignCommit, expectedRevisions[variant]);
  assert.equal(provenance.variant, variant);
  assert.equal(provenance.xcode, "Xcode 26.6\nBuild version 17F113");
  assert.equal(provenance.swift, "Apple Swift version 6.3.3 (swiftlang-6.3.3.1.3 clang-2100.1.1.101)\nTarget: arm64-apple-macosx26.0");
  assert.equal(provenance.iPhoneOSSDK, "26.5");

  const lock = readJSON(root, "xtool/xtool/Package.resolved");
  const rcodesignPins = lock.pins.filter((pin) => pin.identity === "swift-rcodesign");
  assert.equal(rcodesignPins.length, 1);
  assert.deepEqual(rcodesignPins[0], {
    identity: "swift-rcodesign",
    kind: "remoteSourceControl",
    location: "https://github.com/bvolpato/swift-rcodesign",
    state: { revision: expectedRevisions[variant] },
  });
  recorded[variant] = {
    provenance,
    lock,
    originalLock: readJSON(root, "_temp/original-package-resolved.json"),
    buildLog: readText(root, "_temp/ios-xkit-build.log"),
  };
}

assert.deepEqual(nonRCodesignPins(recorded.baseline.lock), nonRCodesignPins(recorded.candidate.lock));
assert.deepEqual(recorded.baseline.originalLock, recorded.candidate.originalLock);
const originalPins = nonRCodesignPins(recorded.baseline.originalLock);
const compilerPins = nonRCodesignPins(recorded.baseline.lock);
const originalIssueReporting = originalPins.filter((pin) => pin.identity === "swift-issue-reporting");
const compilerIssueReporting = compilerPins.filter((pin) => pin.identity === "xctest-dynamic-overlay");
assert.equal(originalIssueReporting.length, 1);
assert.equal(compilerIssueReporting.length, 1);
assert.deepEqual(originalIssueReporting[0].state, {
  revision: "b23bb4493c439d3e05152bc167014235ba3d47fc",
  version: "2.1.2",
});
assert.deepEqual(compilerIssueReporting[0].state, {
  revision: "d9308ad679143c26a30dec52daefe82f54af2b82",
  version: "1.13.1",
});
assert.deepEqual(
  originalPins.filter((pin) => pin.identity !== "swift-issue-reporting"),
  compilerPins.filter((pin) => pin.identity !== "xctest-dynamic-overlay"),
);

assert.match(recorded.baseline.buildLog, /error: unable to resolve module dependency: 'RCodesignBinary'/i);
assert.match(recorded.baseline.buildLog, /^\*\* BUILD FAILED \*\*$/m);
assert.doesNotMatch(recorded.baseline.buildLog, /^\*\* BUILD SUCCEEDED \*\*$/m);
assert.match(recorded.candidate.buildLog, /^\*\* BUILD SUCCEEDED \*\*$/m);
assert.doesNotMatch(recorded.candidate.buildLog, /^\*\* BUILD FAILED \*\*$/m);
assert.doesNotMatch(recorded.candidate.buildLog, /error: unable to resolve module dependency: 'RCodesignBinary'/i);

const result = {
  sourceCommit,
  recordedWorkflowCommit,
  comparisonWorkflowCommit: process.env.GITHUB_SHA ?? null,
  recordedRun: "43039842565",
  baselineArtifact: "13864734802",
  candidateArtifact: "13864304704",
  rcodesignRevisions: expectedRevisions,
  xcode: recorded.baseline.provenance.xcode,
  swift: recorded.baseline.provenance.swift,
  iPhoneOSSDK: recorded.baseline.provenance.iPhoneOSSDK,
  allNonRCodesignActualPinsIdentical: true,
  onlyCompilerManifestSubstitution: "swift-issue-reporting 2.1.2 -> xctest-dynamic-overlay 1.13.1",
  baselineBuild: "RCodesignBinary module dependency failure",
  candidateBuild: "BUILD SUCCEEDED",
};
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    "Recorded native comparison passed.",
    "",
    `Both archived builds use consumer ${sourceCommit}, Xcode 26.6, Swift 6.3.3, and iPhoneOS SDK 26.5.`,
    "All actual non-RCodesign resolved pins are identical. The unchanged RCodesign product fails to resolve its C module; the product-only candidate builds successfully.",
    "The Swift 6.3 dependency manifests select xctest-dynamic-overlay instead of the Swift 6.4 root lockfile's swift-issue-reporting. Every remaining pin is unchanged.",
    "This job verifies recorded artifacts and does not execute another native build.",
    "",
  ].join("\n"));
}
