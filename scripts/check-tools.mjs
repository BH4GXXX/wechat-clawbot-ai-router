#!/usr/bin/env node
/**
 * 本机 AI 工具体检 / 可用性矩阵（对应 T04、T07、T11）
 *
 * 用法：
 *   node scripts/check-tools.mjs                  # 只体检配置与命令，不调用任何 AI
 *   node scripts/check-tools.mjs --live           # 逐个真实调用，报告「可用 / 不可用」
 *   node scripts/check-tools.mjs --failover       # 在真实工具前插入一个模拟故障，验证会自动切换
 *   node scripts/check-tools.mjs --live --json    # 机器可读输出
 *
 * 说明：
 *   - 每次探测都使用独立的临时状态目录，不会读写项目里的 .router-state，
 *     也不会因为某个工具的冷却状态影响另一个工具的探测结果。
 *   - --live 会用你的账号真实调用（豆包会真实建会话），请按需使用。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readConfig, normalizeConfig, executable } from '../lib/config.mjs';
import { route } from '../lib/engine.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const live = flag('--live');
const failover = flag('--failover');
const asJson = flag('--json');
const configFile = resolve(value('--config', 'config.json'));
const prompt = value('--prompt', '只回复 ROUTER_OK');

/** 「工具暂时不可用」类错误的模式表，与 config.json 给 deepseek / doubao 配的口径一致。 */
const UNAVAILABLE_PATTERNS = [
  'quota', 'usage limit', 'overloaded', 'service unavailable', 'temporarily unavailable',
  'rate.?limit', 'too many requests', '\\b429\\b', '\\b503\\b', '额度(?:不足|耗尽|用完)',
];

const base = dirname(configFile);
const config = await readConfig(configFile);
const stdout = [];
const log = (line = '') => { stdout.push(line); if (!asJson) console.log(line); };

async function withStateDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-router-check-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// ---------- 1. 配置体检（不调用 AI） ----------
const inventory = [];
for (const p of config.providers) {
  const binary = executable(p.command, { ...process.env, ...p.env });
  const cwdOk = (() => { try { return statSync(p.cwd).isDirectory(); } catch { return false; } })();
  inventory.push({
    name: p.name,
    priority: p.priority,
    output: p.output,
    command: p.command,
    commandFound: Boolean(binary),
    pathIndependent: p.command.startsWith('/'),
    cwd: p.cwd,
    cwdExists: cwdOk,
    mayFailover: p.retrySafe === true,
    retryPatterns: p.retryPatterns.length,
  });
}

const results = { config: configFile, stateDirPolicy: '每次探测使用独立临时目录', providers: inventory, live: null, failover: null };

log(`本机 AI 工具体检 · ${new Date().toLocaleString('zh-CN')}`);
log(`配置：${configFile}`);
log('');
log('【配置体检】不调用任何 AI');
log(`  ${'工具'.padEnd(10)}${'优先级'.padEnd(8)}${'输出'.padEnd(14)}${'命令'.padEnd(6)}${'绝对路径'.padEnd(10)}${'工作目录'.padEnd(10)}故障切换`);
for (const p of inventory) {
  log(`  ${p.name.padEnd(10)}${String(p.priority).padEnd(8)}${p.output.padEnd(14)}${(p.commandFound ? '✔' : '✘').padEnd(6)}${(p.pathIndependent ? '✔' : '✘').padEnd(10)}${(p.cwdExists ? '✔' : '✘').padEnd(10)}${p.mayFailover ? `retrySafe(${p.retryPatterns} 条)` : '安全默认（不切换）'}`);
}

// ---------- 2. 真实探测 ----------
if (live || failover) {
  const raw = {
    cooldownSeconds: config.cooldownSeconds,
    stateDir: '.',
    providers: [
      ...(failover ? [{
        name: 'simulated-outage', command: process.execPath,
        args: ['-e', "console.error('quota exceeded');process.exitCode=1"],
        output: 'text', retrySafe: true, retryPatterns: UNAVAILABLE_PATTERNS, priority: 1,
      }] : []),
      ...config.providers,
    ],
  };

  if (failover) {
    const outcome = await withStateDir(async (stateDir) => {
      const started = Date.now();
      const c = normalizeConfig({ ...raw, stateDir }, base);
      try {
        const r = await route(c, { id: `failover-${Date.now()}`, prompt });
        return { ok: true, ms: Date.now() - started, result: r };
      } catch (e) {
        return { ok: false, ms: Date.now() - started, kind: e.kind || 'unknown', message: e.message };
      }
    });
    results.failover = outcome;
    log('');
    log('【切换验证】在最前面插入一个「额度耗尽」的模拟工具，看是否会自动切换');
    if (outcome.ok) {
      log(`  ✔ 由 ${outcome.result.provider} 接管，耗时 ${outcome.ms}ms`);
      log(`    切换链：${outcome.result.attempts.map((a) => `${a.provider}(${a.kind})`).join(' → ') || '（未发生切换）'}`);
      log(`    回复：${JSON.stringify(outcome.result.text.slice(0, 80))}`);
    } else {
      log(`  ✘ 没有工具能接管：${outcome.kind} · ${outcome.message}（耗时 ${outcome.ms}ms）`);
    }
  }

  if (live) {
    log('');
    log('【真实探测】逐个真实调用（会产生真实请求）');
    const rows = [];
    for (const p of config.providers) {
      const outcome = await withStateDir(async (stateDir) => {
        const started = Date.now();
        const c = normalizeConfig({ ...raw, stateDir }, base);
        try {
          const r = await route(c, { id: `live-${p.name}-${Date.now()}`, provider: p.name, prompt });
          return { name: p.name, status: '可用', ms: Date.now() - started, text: r.text, attempts: r.attempts };
        } catch (e) {
          return { name: p.name, status: '不可用', ms: Date.now() - started, kind: e.kind || 'unknown', message: e.message };
        }
      });
      rows.push(outcome);
      log(outcome.status === '可用'
        ? `  ${outcome.name.padEnd(10)}可用    ${String(outcome.ms).padStart(6)}ms   ${JSON.stringify(outcome.text.slice(0, 60))}`
        : `  ${outcome.name.padEnd(10)}不可用  ${String(outcome.ms).padStart(6)}ms   ${outcome.kind} · ${outcome.message}`);
    }
    results.live = rows;
  }
}

if (asJson) console.log(JSON.stringify(results, null, 2));

const anyUsable = inventory.some((p) => p.commandFound && p.cwdExists);
const liveOk = results.live ? results.live.some((r) => r.status === '可用') : true;
process.exitCode = anyUsable && liveOk ? 0 : 1;
