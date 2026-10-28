import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { TestContext } from "node:test";

type SourceContract = {
  name: string;
  scratchName: string;
  sourceDirectory: string;
  patch: string;
  verify(root: string): void;
  verifyReversed(directory: string, receipt: Record<string, unknown>): void;
  verifyDrift(scratch: string, directory: string): void;
};

export function registerSourceContractTest(
  root: string,
  contract: SourceContract,
  test: (name: string, body: (context: TestContext) => void) => void,
) {
  test(contract.name, (context) => {
    contract.verify(root);
    mkdirSync(resolve(root, ".build"), { recursive: true });
    const scratch = mkdtempSync(resolve(root, `.build/${contract.scratchName}-`));
    context.after(() => rmSync(scratch, { recursive: true, force: true }));
    const directory = resolve(scratch, contract.sourceDirectory);
    cpSync(resolve(root, contract.sourceDirectory), directory, { recursive: true });
    const receipt = JSON.parse(readFileSync(resolve(directory, "provenance.json"), "utf8"));
    execFileSync("git", ["apply", "--no-index", "--reverse", contract.patch], {
      cwd: directory,
    });
    contract.verifyReversed(directory, receipt);
    contract.verifyDrift(scratch, directory);
  });
}
