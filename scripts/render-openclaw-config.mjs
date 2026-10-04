#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || 'openclaw.generated.local.json5');
const escapeJsonString = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

const replacements = {
  __ROUTER_ROOT__: escapeJsonString(projectRoot),
  __HOME__: escapeJsonString(homedir()),
  __NODE_BINARY__: escapeJsonString(process.execPath),
};

let text = await readFile(resolve(projectRoot, 'openclaw.config.example.json5'), 'utf8');
for (const [token, value] of Object.entries(replacements)) text = text.replaceAll(token, value);
const unresolved = text.match(/__[A-Z0-9_]+__/g);
if (unresolved) throw new Error(`配置模板仍有未替换项：${[...new Set(unresolved)].join(', ')}`);

await writeFile(output, text, { flag: 'wx', mode: 0o600 });
console.log(`已生成本机配置：${output}`);
console.log('请关闭未安装的 provider，然后运行：openclaw config patch --file <上面的文件>');
