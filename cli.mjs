#!/usr/bin/env node
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readConfig, discoverProvider, executable } from './lib/config.mjs';
import { route, status } from './lib/engine.mjs';

export async function readStdin() {
  let data=''; for await(const part of process.stdin) { data+=part; if(Buffer.byteLength(data)>8*1024*1024) throw new Error('输入超过 8 MiB'); } return data;
}
export async function main(args=process.argv.slice(2)) {
  const command=args.shift() || 'help';
  const options={};
  while(args.length) { const key=args.shift(); if(!['--config','--prompt','--id','--provider','--session','--json'].includes(key)) throw new Error(`未知选项：${key}`); if(key==='--json') options.json=true; else { if(!args.length) throw new Error(`${key} 缺少参数`); options[key.slice(2)]=args.shift(); } }
  const file=resolve(options.config || 'config.json');
  if(command==='help') { console.log('本机 AI 路由器\n  node cli.mjs init\n  node cli.mjs doctor [--config config.json]\n  node cli.mjs status\n  node cli.mjs run --prompt "任务" [--id 消息ID] [--provider 名称] [--session 会话ID] [--json]\n  node cli.mjs run --json  # 标准输入接收 {id,prompt,provider}'); return; }
  if(command==='init') {
    const template=JSON.parse(await readFile(new URL('./config.example.json',import.meta.url),'utf8'));
    template.providers.forEach(p=>{
      p.cwd=dirname(file);
      const binary=discoverProvider(p);
      p.enabled=Boolean(binary);
      if(binary) p.command=binary;
    });
    await writeFile(file,JSON.stringify(template,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(`配置已创建：${file}\n已将找到的 CLI 写为绝对路径，避免应用间 PATH 不同。请确认登录和工作目录，再运行 doctor。`); return;
  }
  const config=await readConfig(file);
  if(command==='doctor') {
    const checks=[];
    for(const p of config.providers) {
      let directory=true; try { await access(p.cwd); } catch { directory=false; }
      const { isAbsolute } = await import('node:path');
      checks.push({name:p.name,configuredCommand:p.command,command:executable(p.command,{...process.env,...p.env}) || null,pathIndependent:isAbsolute(p.command),directory:directory ? p.cwd : null,login:'未检查；请在工具本身确认登录'});
    }
    console.log(JSON.stringify({platform:process.platform,supported:['darwin','win32'].includes(process.platform),providers:checks},null,2));
    if(checks.some(p=>!p.command || !p.directory)) process.exitCode=1;
    return;
  }
  if(command==='status') { console.log(JSON.stringify(await status(config),null,2)); return; }
  if(command!=='run') throw new Error(`未知命令：${command}`);
  const request=options.prompt ? {prompt:options.prompt,id:options.id,provider:options.provider,sessionId:options.session} : options.json ? JSON.parse(await readStdin()) : {prompt:await readStdin(),id:options.id,provider:options.provider,sessionId:options.session};
  const controller=new AbortController(); const cancel=()=>controller.abort();
  process.on('SIGINT',cancel); process.on('SIGTERM',cancel);
  try { const result=await route(config,request,controller.signal); console.log(options.json ? JSON.stringify(result) : result.text); }
  finally { process.off('SIGINT',cancel);process.off('SIGTERM',cancel); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(e=>{console.error(JSON.stringify({error:e.kind || 'configuration_error',message:e.message}));process.exitCode=1;});
