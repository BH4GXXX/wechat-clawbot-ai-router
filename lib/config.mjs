import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, delimiter, extname, join } from 'node:path';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';

export const presets = {
  codex: { command: 'codex', args: ['exec', '--json', '--skip-git-repo-check', '-'], output: 'codex-jsonl' },
  claude: { command: 'claude', args: ['-p', '--output-format', 'stream-json', '--verbose'], output: 'claude-jsonl' },
};
export function executable(command, env = process.env) {
  const paths = command.includes('/') || command.includes('\\') ? [''] : (env.PATH || env.Path || '').split(delimiter);
  const extensions = process.platform === 'win32' && !extname(command) ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of paths) for (const extension of extensions) {
    const file = resolve(dir, command + extension);
    try { accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); if (statSync(file).isFile()) return file; } catch {}
  }
  return null;
}
export function discoverProvider(provider, env = process.env) {
  const command = provider.command || presets[provider.preset]?.command;
  if (!command) return null;
  const found = executable(command, env);
  if (found) return found;
  // An explicitly configured path must not silently select a different binary.
  if (provider.command || provider.preset !== 'codex' || process.platform !== 'darwin') return null;
  for (const candidate of [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  ]) {
    const binary = executable(candidate, env);
    if (binary) return binary;
  }
  return null;
}
// Resolve standard npm Node shims without passing prompts through cmd.exe.
export function launchCommand(command, env) {
  const file = executable(command, env);
  if (!file) throw Object.assign(new Error(`找不到命令：${command}`), { code: 'ENOENT' });
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const text = readFileSync(file, 'utf8');
    const match = text.match(/"%(?:dp0|~dp0)%?\\([^"\r\n]+\.(?:js|cjs|mjs))"/i);
    if (!match) throw new Error('不支持此 Windows 脚本包装器，请将 command 设为 node 并在 args 中指定 CLI 的 JavaScript 入口。');
    const script = join(file, '..', match[1]);
    if (!statSync(script).isFile()) throw new Error('npm CLI 入口不存在');
    return { command: process.execPath, prefix: [script] };
  }
  return { command: file, prefix: [] };
}
export function normalizeConfig(raw, base = process.cwd()) {
  if (!raw || !Array.isArray(raw.providers) || !raw.providers.length) throw new Error('请至少配置一个 AI 工具。');
  const names = new Set();
  const providers = raw.providers.map((item) => {
    if (!item || typeof item.name !== 'string' || !/^[\w.-]+$/.test(item.name) || names.has(item.name) || Object.hasOwn(Object.prototype,item.name)) throw new Error('AI 名称必须唯一，仅包含字母、数字、下划线、点或横线。');
    names.add(item.name);
    if (item.preset && !presets[item.preset]) throw new Error(`未知预设：${item.preset}`);
    const p = { priority: 100, timeoutSeconds: 300, input: 'stdin', output: 'text', args: [], env: {}, retryPatterns: [], ...presets[item.preset], ...item };
    if (typeof p.command !== 'string' || !p.command.trim()) throw new Error(`${p.name} 缺少 command 或 preset`);
    if (!Array.isArray(p.args) || !p.args.every(x => typeof x === 'string')) throw new Error(`${p.name} args 必须为字符串数组`);
    if (!['stdin', 'arg'].includes(p.input) || !['text','json','codex-jsonl','claude-jsonl'].includes(p.output)) throw new Error(`${p.name} 输入输出格式无效`);
    if (!Number.isFinite(p.timeoutSeconds) || p.timeoutSeconds <= 0 || p.timeoutSeconds > 86400 || !Number.isFinite(p.priority)) throw new Error(`${p.name} 超时或优先级无效`);
    if (p.idleTimeoutSeconds !== undefined && (!Number.isFinite(p.idleTimeoutSeconds) || p.idleTimeoutSeconds <= 0 || p.idleTimeoutSeconds > p.timeoutSeconds)) throw new Error(`${p.name} 空闲超时必须大于 0 且不超过总超时`);
    if (!p.env || Array.isArray(p.env) || typeof p.env !== 'object' || !Object.values(p.env).every(x => typeof x === 'string')) throw new Error(`${p.name} env 必须是字符串映射`);
    if (!Array.isArray(p.retryPatterns) || !p.retryPatterns.every(x => typeof x === 'string')) throw new Error('retryPatterns 必须是字符串数组');
    if (p.persistTask !== undefined && typeof p.persistTask !== 'boolean') throw new Error(`${p.name} persistTask 必须是布尔值`);
    if (p.taskLabel !== undefined && (typeof p.taskLabel !== 'string' || !p.taskLabel.trim() || p.taskLabel.length > 80)) throw new Error(`${p.name} taskLabel 必须是 1-80 个字符`);
    p.retryPatterns.forEach(x => new RegExp(x, 'iu'));
    p.cwd = resolve(base, p.cwd || '.');
    p.retrySafe = p.retrySafe === true;
    p.persistTask = p.persistTask === true;
    p.taskLabel = p.taskLabel?.trim() || '本机路由任务';
    return p;
  }).filter(p => p.enabled !== false).sort((a,b) => a.priority - b.priority);
  if (!providers.length) throw new Error('没有启用的 AI 工具');
  const cooldownSeconds = raw.cooldownSeconds ?? 60;
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 0) throw new Error('cooldownSeconds 必须是非负数');
  const failoverPolicy = raw.failoverPolicy ?? 'availability-first';
  if (!['safe','availability-first'].includes(failoverPolicy)) throw new Error('failoverPolicy 必须是 safe 或 availability-first');
  return { providers, cooldownSeconds, failoverPolicy, stateDir: resolve(base, raw.stateDir || '.router-state') };
}
export async function readConfig(file) {
  const { dirname } = await import('node:path');
  return normalizeConfig(JSON.parse(await readFile(file, 'utf8')), dirname(resolve(file)));
}
