import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const original = "  return staleness\n}";
const replacement = `  // Full precision plus the racy-index window: coarse or equal timestamps cannot
  // prove equal content immediately after a write. Rehash these recent files.
  return staleness ||
    e.mtimeNanoseconds !== s.mtimeNanoseconds ||
    e.ctimeNanoseconds !== s.ctimeNanoseconds ||
    s.mtimeSeconds >= Math.floor(Date.now() / 1000) - 1
}`;

const incompleteMerge = `        trees: [TREE({ ref: results.oid })],
        map: async function (filepath, [entry]) {
          const path = \`\${dir}/\${filepath}\`;
          if ((await entry.type()) === 'blob') {
            const mode = await entry.mode();
            const content = await entry.content();
            await fs.write(path, content, { mode });
          }
          return true
        },`;
const completeMerge = `        trees: [TREE({ ref: ourOid }), TREE({ ref: results.oid })],
        map: async function (filepath, [before, entry]) {
          const path = \`\${dir}/\${filepath}\`;
          const conflict = unmergedFiles.includes(filepath);
          if (!entry && (await before?.type()) === 'blob' && !conflict) {
            await fs.rm(path);
            index.delete({ filepath });
          }
          if ((await entry?.type()) !== 'blob') return true
          const mode = await entry.mode();
          const content = await entry.content();
          await fs.write(path, content, { mode });
          if (conflict) return true
          index.insert({ filepath, oid: await entry.oid(), stats: await fs.lstat(path) });
          return true
        },`;

const missingAbortPath = `              }
            : undefined
        }

        if (unmodified) return false`;
const preservedAbortPath = `              }
            : (await workdir?.type()) === 'blob' || (await index?.type()) === 'blob'
              ? { path, type: 'remove' }
              : false
        }

        if (unmodified) return false`;
const missingAbortRemoval = `          if (!entry) {
            await fs.rmdir(\`\${dir}/\${entry.path}\`, { recursive: true });
            index.delete({ filepath: entry.path });
            continue
          }`;
const completeAbortRemoval = `          if (entry.type === 'remove') {
            await fs.rm(\`\${dir}/\${entry.path}\`);
            index.delete({ filepath: entry.path });
            continue
          }`;

const sources = [
  ["index.js", "e4b1c6d807e8d7a8889385061f9d7b06e9f147c4da3f8393f98eb99f470e100e"],
  ["index.cjs", "55f1a87544a75ba5970322ec7e3dcaa6f64b0d0e9f3d1d27f609b9463a63fdb8"],
  ["managers/index.js", "780a4b5ea20e2df44e5dfe5aafc694ecba01b71eb62c73275daaba22465b20fb"],
  ["managers/index.cjs", "2a282925897c59d23742b31f743735f877d00c6991348c265a9fc0c8c6c9229f"],
  ["models/index.js", "861f4111e5fcf21d57f77e4197669302fceae4f701deeb88065057d795376514"],
];
const mergeLabel = "ourName: abbreviateRef(ours),";
const headLabel = 'ourName: "HEAD",';
const decodedAbort = "const content = new TextDecoder().decode(entry.content);";
const binaryAbort = "const content = entry.content;";
const browserBuffer = "import { Buffer } from 'buffer';\n";

/** One bounded upstream correctness patch, applied before bundling or running Git. */
export function patchGitSource(root = resolve(import.meta.dirname, "..")) {
  const directory = resolve(root, "node_modules/isomorphic-git");
  const manifest: unknown = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  assert.ok(manifest && typeof manifest === "object" && "version" in manifest);
  assert.equal(manifest.version, "1.44.5");
  const changes = sources.map(([file, expected]) => {
    const path = resolve(directory, file);
    const source = readFileSync(path, "utf8");
    const unpatched = source.includes(replacement) ? source.replace(replacement, original) : source;
    const withoutLabel = unpatched
      .replace(headLabel, mergeLabel)
      .replace(binaryAbort, decodedAbort)
      .replace(completeMerge, incompleteMerge)
      .replace(preservedAbortPath, missingAbortPath)
      .replace(completeAbortRemoval, missingAbortRemoval);
    const pristine =
      file.endsWith(".js") && withoutLabel.startsWith(browserBuffer)
        ? withoutLabel.slice(browserBuffer.length)
        : withoutLabel;
    assert.equal(
      createHash("sha256").update(pristine).digest("hex"),
      expected,
      `unrecognized Git source: ${file}`,
    );
    assert.equal(pristine.split(original).length, file.startsWith("models/") ? 1 : 2);
    if (file === "index.js" || file === "index.cjs")
      assert.equal(pristine.split(incompleteMerge).length, 2);
    const patched =
      (file.endsWith(".js") ? browserBuffer : "") +
      pristine
        .replace(original, replacement)
        .replace(mergeLabel, headLabel)
        .replace(decodedAbort, binaryAbort)
        .replace(incompleteMerge, completeMerge)
        .replace(missingAbortPath, preservedAbortPath)
        .replace(missingAbortRemoval, completeAbortRemoval);
    return { path, source, patched };
  });
  for (const { path, source, patched } of changes)
    if (source !== patched) writeFileSync(path, patched);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  patchGitSource();
