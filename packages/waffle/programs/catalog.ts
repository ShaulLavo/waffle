import type { PackageProgram, ProgramPackage } from "./index.js";

export interface ProgramCatalog extends ProgramPackage {
  pick(...names: string[]): ProgramPackage;
}

const identityKey = Symbol.for("waffle.programPackage.identity");
export function packageIdentity(pkg: ProgramPackage): object {
  if (identityKey in pkg && typeof pkg[identityKey] === "object" && pkg[identityKey] !== null)
    return pkg[identityKey];
  return pkg;
}

/** A selection retains each definition and its package's payload ownership. */
export function defineProgramPackage(pkg: ProgramPackage): ProgramCatalog {
  const identity = packageIdentity(pkg);
  const catalog = Object.freeze({
    ...pkg,
    [identityKey]: identity,
    pick(...names: string[]): ProgramPackage {
      const programs = names.map((name) => {
        const program = pkg.programs.find((entry) => matchesProgram(entry, name));
        if (!program) throw new TypeError(`Unknown program ${name} in ${pkg.name}`);
        return program;
      });
      const selected = { ...pkg, [identityKey]: identity, programs: Array.from(new Set(programs)) };
      return selected;
    },
  });
  return catalog;
}

export function matchesProgram(program: PackageProgram, name: string): boolean {
  return (
    program.path === name ||
    program.path.slice(program.path.lastIndexOf("/") + 1) === name ||
    (program.aliases?.includes(name) ?? false)
  );
}
