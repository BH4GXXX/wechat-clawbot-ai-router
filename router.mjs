import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from './lib/config.mjs';
import { readStdin } from './cli.mjs';
import { route } from './lib/engine.mjs';
const controller=new AbortController();
process.on('SIGINT',()=>controller.abort());
process.on('SIGTERM',()=>controller.abort());
try {
  let sessionId;
  for(let i=2;i<process.argv.length;i++) {
    if(process.argv[i]==='--session-id' && process.argv[i+1]) sessionId=process.argv[++i];
    else throw new Error(`未知选项：${process.argv[i]}`);
  }
  const raw=process.env.JIJIN_AI_ROUTER_CONFIG ? JSON.parse(process.env.JIJIN_AI_ROUTER_CONFIG) : {
    providers:JSON.parse(process.env.JIJIN_AI_ROUTER_PROVIDERS || '[]'),
    cooldownSeconds:Number(process.env.JIJIN_AI_ROUTER_COOLDOWN_SECONDS || 60),
    stateDir:join(homedir(),'.jijin-ai-router'),
  };
  const result=await route(normalizeConfig(raw),{prompt:await readStdin(),sessionId,source:'微信 ClawBot'},controller.signal);
  process.stdout.write(result.text);
} catch(e) { console.error(`${e.kind || 'error'}: ${e.message}`);process.exitCode=1; }
