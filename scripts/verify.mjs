import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {readConfig} from '../lib/config.mjs';
const exec=promisify(execFile), root=fileURLToPath(new URL('..',import.meta.url));
const options={live:false,bridge:join(root,'integrations/workbuddy/local-ai-router/scripts/run.mjs')};
const args=process.argv.slice(2);
while(args.length){const key=args.shift();if(key==='--live')options.live=true;else if(key==='--bridge' && args.length)options.bridge=resolve(args.shift());else throw new Error(`未知选项 ${key}`);}
const report={startedAt:new Date().toISOString(),platform:process.platform,node:process.version,checks:[],limitations:['进程级调用不等于 WorkBuddy 模型调用或其安全中心放行','不覆盖手机微信收发、Windows 实机、豆包 CDP 通道的长时间稳定性或独立 ClawBot 接入']};
const dir=await mkdtemp(join(tmpdir(),'router-verify-'));
async function check(name,fn){try{const detail=await fn();report.checks.push({name,status:'passed',detail});console.log(`通过：${name}`);}catch(e){report.checks.push({name,status:'failed',detail:e.message.slice(0,1000)});console.log(`失败：${name}`);throw e;}}
try{
 await check('自动化回归',async()=>{
  const files=(await readdir(join(root,'tests'))).filter(x=>x.endsWith('.test.mjs')).map(x=>join(root,'tests',x));
  const r=await exec(process.execPath,['--test',...files],{cwd:root,timeout:60000,maxBuffer:2*1024*1024});return r.stdout.slice(-400);
 });
 const env={...process.env,PATH:process.platform==='win32'?process.env.SystemRoot+'\\System32':'/usr/bin:/bin'};
 await check('已安装技能：最小 PATH 环境诊断',async()=>{
  const r=await exec(process.execPath,[options.bridge,'--doctor'],{cwd:root,env,timeout:10000});
  const d=JSON.parse(r.stdout);if(d.providers.some(p=>!p.command||!p.pathIndependent))throw new Error('命令缺失或仍然依赖 PATH');return d;
 });
 if(options.live){
  const config=await readConfig(join(root,'config.json'));
  const provider=config.providers.find(p=>p.preset==='codex');if(!provider)throw new Error('没有启用的 Codex 适配器');
  const cf=join(dir,'config.json'),settings=join(dir,'settings.json'),request=join(dir,'request.json');
  await writeFile(cf,JSON.stringify({stateDir:join(dir,'state'),providers:[{...provider,args:['exec','--json','--sandbox','read-only','--skip-git-repo-check','-'],timeoutSeconds:60}]}),{mode:0o600});
  await writeFile(settings,JSON.stringify({routerRoot:root,nodeBinary:process.execPath,configFile:cf}),{mode:0o600});
  await writeFile(request,JSON.stringify({id:randomUUID(),provider:provider.name,prompt:'连接检查。不要调用工具、读取文件或修改任何内容。请只回复 ROUTER_OK。'}),{mode:0o600});
  const call=async()=>JSON.parse((await exec(process.execPath,[options.bridge,'--settings',settings,'--request',request],{cwd:root,env,timeout:70000,maxBuffer:1024*1024})).stdout);
  await check('已安装技能 → 路由器 → 真实 Codex',async()=>{const r=await call();if(r.text!=='ROUTER_OK'||r.cached!==false)throw new Error('真实响应不符合连接检查预期');return {provider:r.provider,text:r.text,cached:r.cached};});
  await check('重复请求只读取缓存',async()=>{const r=await call();if(!r.cached||r.text!=='ROUTER_OK')throw new Error('缓存重放失败');return {provider:r.provider,cached:r.cached};});
 } else report.checks.push({name:'真实 AI 调用',status:'not_run',detail:'使用 --live 显式启用，可能消耗少量额度'});
}catch{process.exitCode=1;}finally{
 report.finishedAt=new Date().toISOString();
 await writeFile(join(root,'verification.local.json'),JSON.stringify(report,null,2)+'\n');
 await rm(dir,{recursive:true,force:true});
 console.log('报告：'+join(root,'verification.local.json'));
}
