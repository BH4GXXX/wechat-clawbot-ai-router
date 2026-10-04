#!/usr/bin/env node
/**
 * 一次性体检：codex 额度是否恢复 + 路由器端到端选路是否正常。
 *
 * 用法（在终端里跑，不需要任何参数）：
 *   /opt/homebrew/opt/node/bin/node scripts/try-codex.mjs
 *
 * 做三件事：
 *   1. 直连 codex 问一句话，判断额度是否恢复（不经过路由器）
 *   2. 走生产入口 router.mjs 提交一个可验证的编码任务（微信 ClawBot 走的就是这条路径）
 *   3. 读状态文件，报出「谁真的答的」和完整切换链
 *
 * 只读性质：除了写 .probe/ 下的中间文件外不做任何改动。
 */
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = '/opt/homebrew/opt/node/bin/node';
const CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const PROBE = join(ROOT, '.probe');
const ROUTER_TIMEOUT_MS = 6 * 60 * 1000;

const DIRECT_ASK = '用一句话说明什么是游程编码。';
const ROUTER_ASK = [
  '用 JavaScript 写一个函数 rle(str)，做游程编码：把连续重复字符压成「字符+次数」，',
  '例如 "aaabbc" -> "a3b2c1"。"aabbaa" -> "a2b2a2"。只输出代码块，不要解释。',
].join('');

// ---------- 小工具 ----------

function hr(title) {
  console.log('\n' + '='.repeat(8) + ' ' + title + ' ' + '='.repeat(8));
}

function run(cmd, args, { input = '', env = process.env, timeoutMs = ROUTER_TIMEOUT_MS, cwd = ROOT } = {}) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return done({ code: -1, out: '', err: `无法启动 ${cmd}: ${e.message}`, timedOut: false });
    }
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); done({ code: -1, out, err: err + '\n' + e.message, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, out, err, timedOut }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** 从 codex 的 JSONL 事件流里抽出助手正文、错误信息和会话 id。 */
function parseCodexJsonl(raw) {
  const messages = [], errors = [], notes = [];
  let threadId = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    const type = String(ev.type || '');
    if (ev.thread_id) threadId = ev.thread_id;
    if (type === 'error' && ev.message) errors.push(String(ev.message));
    if (type === 'turn.failed' && ev.error?.message) errors.push(String(ev.error.message));
    const item = ev.item;
    if (item && typeof item === 'object' && typeof item.text === 'string' && /message|reasoning/.test(String(item.type || ''))) {
      if (/agent_message|assistant/.test(String(item.type || ''))) messages.push(item.text);
      else notes.push(`[${item.type}] ${item.text.slice(0, 200)}`);
    }
    if (!item && typeof ev.text === 'string' && /message|output|delta/.test(type)) messages.push(ev.text);
  }
  return { text: messages.join('\n').trim(), errors, notes, threadId };
}

/**
 * 「额度/可用性」类故障的判据。
 * 与 config.json 里 codex 依赖的内置 unavailable 正则保持同一批关键词。
 */
const UNAVAILABLE_RE = /usage limit|rate.?limit|too many requests|quota|额度(?:不足|耗尽|用完)|限流|overloaded|服务暂不可用|temporarily unavailable|service unavailable|\b429\b|\b503\b|not logged in|unauthorized|Missing bearer|Invalid API key|MISSING_CREDENTIAL/i;

/** 从模型回答里抠出代码块并真跑断言。 */
async function assertRle(text) {
  const m = text.match(/```(?:js|javascript|ts)?\s*\n([\s\S]*?)```/) || [null, text];
  let src = (m[1] || '').trim();
  if (!src) return { ok: false, detail: '回答里没有可用代码' };
  const cases = [
    ['aaabbc', 'a3b2c1'], ['', ''], ['a', 'a1'],
    ['abcd', 'a1b1c1d1'], ['zzzz', 'z4'], ['aabbaa', 'a2b2a2'],
  ];
  const attempts = [];
  // 策略 1：当 ESM 模块 import
  try {
    const body = /\bexport\b/.test(src) ? src : `${src}\nexport { rle };`;
    const mod = await import('data:text/javascript,' + encodeURIComponent(body));
    attempts.push(mod.rle);
  } catch (e) { attempts.push(null); }
  // 策略 2：CommonJS 风格
  try {
    const fn = new Function(`${src}\n;return typeof rle !== "undefined" ? rle : null;`)();
    attempts.push(typeof fn === 'function' ? fn : null);
  } catch { attempts.push(null); }
  const rle = attempts.find((f) => typeof f === 'function');
  if (!rle) return { ok: false, detail: '拿到代码但无法作为函数调用' };
  const lines = [];
  let pass = 0;
  for (const [input, expect] of cases) {
    let got;
    try { got = rle(input); } catch (e) { got = `<抛错 ${e.message}>`; }
    const good = got === expect;
    if (good) pass++;
    lines.push(`  ${good ? 'PASS' : 'FAIL'}  rle(${JSON.stringify(input)}) = ${JSON.stringify(got)}${good ? '' : `   期望 ${JSON.stringify(expect)}`}`);
  }
  return { ok: pass === cases.length, detail: `${pass}/${cases.length}`, lines };
}

function fmtAttempts(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) return '(无切换)';
  return attempts.map((a) => `${a.provider}→${a.kind}`).join('  →  ');
}

// ---------- 主流程 ----------

async function main() {
  await mkdir(PROBE, { recursive: true });
  let exitCode = 0;

  hr('0. 环境');
  console.log('工作目录 :', ROOT);
  console.log('node     :', (await run(NODE, ['-v'], { timeoutMs: 20000 })).out.trim() || '(无法运行)');
  const ver = await run(CODEX, ['--version'], { timeoutMs: 60000 });
  console.log('codex    :', (ver.out + ver.err).trim().split('\n')[0] || '(无法运行)');
  try { await access(CODEX); console.log('codex 路径存在: 是'); }
  catch { console.log('codex 路径存在: 否  ← 先确认 ChatGPT.app 还在原位'); exitCode = 1; }

  hr('1. 直连 codex（判断额度是否恢复）');
  console.log('提问:', DIRECT_ASK);
  const direct = await run(
    CODEX,
    ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-'],
    { input: DIRECT_ASK, timeoutMs: 4 * 60 * 1000 },
  );
  await writeFile(join(PROBE, 'codex-direct.txt'), direct.out);
  await writeFile(join(PROBE, 'codex-direct.err'), direct.err);
  const d = parseCodexJsonl(direct.out);
  console.log('退出码:', direct.code, direct.timedOut ? '(超时被中止)' : '');
  console.log('回答  :', d.text || '(空)');
  if (d.errors.length) console.log('错误  :', d.errors.join('\n         '));
  const directBlocked = d.errors.some((e) => UNAVAILABLE_RE.test(e));
  if (!d.text && !d.errors.length && direct.err.trim()) console.log('stderr:', direct.err.trim().slice(0, 400));
  if (!d.text && !d.errors.length) {
    console.log('---- 原始 stdout（前 1200 字，用来对照事件结构）----');
    console.log(direct.out.slice(0, 1200) || '(空)');
  }
  console.log(directBlocked
    ? '>>> 结论：codex 仍然不可用（额度/鉴权类错误）'
    : d.text
      ? '>>> 结论：codex 额度已恢复，能正常回答'
      : '>>> 结论：codex 没有回答也没有报错，需要人工看上面的原始输出');
  // 注意：codex 被额度挡住时**不算脚本失败** —— 那正是要多模型兜底的原因。
  // 退出码只反映“路由器这条链路有没有跑通”，见第 2 节。

  hr('2. 路由器端到端（生产入口 router.mjs）');
  const config = await readFile(join(ROOT, 'config.json'), 'utf8');
  let stateDir = join(homedir(), '.jijin-ai-router');
  try { stateDir = JSON.parse(config).stateDir || stateDir; } catch {}
  stateDir = stateDir.replace(/^~(?=\/)/, homedir());
  const stateFile = join(stateDir, 'state.json');
  const lockFile = join(stateDir, 'router.lock');

  // 陈旧锁检查：上一次异常退出会留下 router.lock，导致之后每个任务都直接报 busy。
  let staleLock = false;
  try {
    const lockRaw = await readFile(lockFile, 'utf8');
    staleLock = true;
    console.log('[注意] 发现锁文件:', lockFile);
    console.log('  内容:', lockRaw.trim() || '(空)');
  } catch { /* 没有锁，正常 */ }
  if (staleLock) {
    console.log('  → 若确认当前没有路由器进程在跑，先清掉它再继续：');
    console.log(`     rm -f "${lockFile}"`);
    console.log('  → 本脚本不会自动删，避免误删另一个正在执行的任务的锁。');
    console.log('  → 下面的端到端测试很可能直接报 busy，属预期现象。');
  }

  console.log('候选顺序:', JSON.parse(config).providers
    .filter((p) => p.enabled !== false)
    .sort((a, b) => a.priority - b.priority)
    .map((p) => `${p.name}(${p.priority})`).join('  →  '));
  console.log('提交任务…（最多等 6 分钟）');

  const t0 = Date.now();
  const routed = await run(NODE, [join(ROOT, 'router.mjs')], {
    input: ROUTER_ASK,
    env: { ...process.env, JIJIN_AI_ROUTER_CONFIG: config },
    timeoutMs: ROUTER_TIMEOUT_MS,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  await writeFile(join(PROBE, 'out-try-codex.txt'), routed.out);
  console.log(`退出码: ${routed.code}   耗时: ${elapsed}s` + (routed.timedOut ? '   (超时被中止)' : ''));
  console.log('---- 回答 ----');
  console.log(routed.out.trim() || '(空)');
  if (routed.err.trim()) { console.log('---- stderr ----'); console.log(routed.err.trim()); }
  if (/busy|锁/.test(routed.err)) {
    console.log('↑ 报 busy = 锁没清干净（见第 2 节的 rm -f 命令），不是 codex 的问题。');
  }
  exitCode ||= routed.code === 0 ? 0 : 1;

  if (routed.out.trim()) {
    console.log('---- 产出代码断言 ----');
    const check = await assertRle(routed.out);
    if (check.lines) console.log(check.lines.join('\n'));
    console.log(`>>> 结果: ${check.detail}${check.ok ? '  全部通过' : '  ' + (check.detail || '')}`);
    if (!check.ok) console.log('    (若回答本身不是代码任务，这里失败属正常)');
  }

  hr('3. 谁真的答的 / 切换链');
  console.log('状态文件:', stateFile);
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    const entries = Object.entries(state.requests || {})
      .sort((a, b) => String(a[1].startedAt || '').localeCompare(String(b[1].startedAt || '')));
    for (const [id, r] of entries.slice(-3)) {
      console.log(`\n请求 ${id}`);
      console.log(`  状态     : ${r.status}   开始于 ${r.startedAt}`);
      console.log(`  切换链   : ${fmtAttempts(r.attempts)}`);
      if (r.result) {
        const n = (r.result.text || '').length;
        console.log(`  实际执行 : ${r.result.provider}${r.result.cached ? '  (缓存命中，今日已算过同一任务)' : ''}   文本 ${n} 字`);
        console.log(`  切换记录 : ${fmtAttempts(r.result.attempts)}`);
      }
    }
    console.log('\n各 provider 健康状态:');
    const health = state.health || {};
    const names = Object.keys(health);
    if (!names.length) console.log('  (无记录)');
    for (const n of names) {
      const h = health[n];
      const cd = h.cooldownUntil > Date.now() ? `   冷却中，直到 ${new Date(h.cooldownUntil).toLocaleTimeString()}` : '';
      console.log(`  ${n.padEnd(10)} 最近成功 ${h.lastSuccess || '-'}   最近失败 ${h.lastFailure || '-'} (${h.kind || '-'})${cd}`);
    }
  } catch (e) {
    console.log('  读不到状态文件:', e.message);
  }

  hr('总结');
  console.log(directBlocked
    ? 'codex 仍不可用 → 路由器应当自动落到下一个 provider，看第 2、3 节的切换链是否符合预期。'
    : 'codex 可用 → 第 2 节若由 codex 作答，说明选路正常。');
  console.log('原始证据留在 .probe/：codex-direct.txt、codex-direct.err、out-try-codex.txt');
  process.exitCode = exitCode;
}

main().catch((e) => { console.error('脚本自身出错:', e.stack || e.message); process.exitCode = 1; });
