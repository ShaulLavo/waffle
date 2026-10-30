import type { PackageProgram, ProgramPackage } from "./index.js";

export interface ProgramCatalog extends ProgramPackage {
  pick(...names: string[]): ProgramPackage;
}

const identities = new WeakMap<ProgramPackage, object>();
export function packageIdentity(pkg: ProgramPackage): object {
  return identities.get(pkg) ?? pkg;
}

/** A selection retains each definition and its package's payload ownership. */
export function defineProgramPackage(pkg: ProgramPackage): ProgramCatalog {
  const identity = packageIdentity(pkg);
  const catalog = Object.freeze({
    ...pkg,
    pick(...names: string[]): ProgramPackage {
      const programs = names.map((name) => {
        const program = pkg.programs.find((entry) => matchesProgram(entry, name));
        if (!program) throw new TypeError(`Unknown program ${name} in ${pkg.name}`);
        return program;
      });
      const selected = { ...pkg, programs: Array.from(new Set(programs)) };
      identities.set(selected, identity);
      return selected;
    },
  });
  identities.set(catalog, identity);
  return catalog;
}

export function matchesProgram(program: PackageProgram, name: string): boolean {
  return (
    program.path === name ||
    program.path.slice(program.path.lastIndexOf("/") + 1) === name ||
    (program.aliases?.includes(name) ?? false)
  );
}
