import { runGh } from "./cli.ts";
import { nodeFileSystem } from "./filesystem.ts";
import { executeJq } from "./jq.ts";
import { fetchTransport } from "./transport.ts";

const writer = (stream: NodeJS.WriteStream) => (bytes: Uint8Array) =>
  new Promise<void>((resolve, reject) =>
    stream.write(bytes, (error) => (error ? reject(error) : resolve())),
  );
const env: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;

async function stdin(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(new Uint8Array(chunk));
  return Uint8Array.from(Buffer.concat(chunks));
}

process.exitCode = await runGh({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env,
  stdin,
  stdout: writer(process.stdout),
  stderr: writer(process.stderr),
  filesystem: nodeFileSystem,
  transport: fetchTransport,
  evaluator: executeJq,
});
