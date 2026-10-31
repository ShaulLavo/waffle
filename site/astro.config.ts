import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { defineConfig } from "astro/config";

const analysisPath = process.env.BUNDLE_ANALYSIS;
const analysis: {
  chunks: {
    fileName: string;
    bytes: number;
    gzipBytes: number;
    isEntry: boolean;
    isDynamicEntry: boolean;
    imports: string[];
    dynamicImports: string[];
    modules: {
      id: string;
      sourceLength: number | null;
      renderedLength: number;
      renderedExports: string[];
      declarations: string[];
    }[];
  }[];
} = { chunks: [] };

export default defineConfig({
  output: "static",
  build: { assets: "_astro" },
  security: { checkOrigin: false },
  vite: {
    plugins: analysisPath
      ? [
          {
            name: "waffle-bundle-analysis",
            apply: "build",
            enforce: "post",
            generateBundle: {
              order: "post",
              async handler(_options, bundle) {
                for (const chunk of Object.values(bundle)) {
                  if (chunk.type !== "chunk") continue;
                  analysis.chunks.push({
                    fileName: chunk.fileName,
                    bytes: Buffer.byteLength(chunk.code),
                    gzipBytes: gzipSync(chunk.code).byteLength,
                    isEntry: chunk.isEntry,
                    isDynamicEntry: chunk.isDynamicEntry,
                    imports: chunk.imports,
                    dynamicImports: chunk.dynamicImports,
                    modules: Object.entries(chunk.modules).map(([id, module]) => ({
                      id,
                      sourceLength: this.getModuleInfo(id)?.code?.length ?? null,
                      renderedLength: module.renderedLength,
                      renderedExports: module.renderedExports,
                      declarations: Array.from(
                        module.code?.matchAll(
                          /\b(?:class|function)\s+([\w$]+)|\b(?:var|let|const)\s+([\w$]+)\s*=\s*(?:class|function)\b/g,
                        ) ?? [],
                        (match) => match[1] ?? match[2],
                      ),
                    })),
                  });
                }
                await writeFile(analysisPath, JSON.stringify(analysis, null, 2) + "\n");
              },
            },
          },
        ]
      : [],
  },
});
