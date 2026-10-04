import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from './lib/config.mjs';
import { route, parseRouteControl } from './lib/engine.mjs';
export default definePluginEntry({
  id:'jijin-ai-router',name:'Jijin Local AI Router',description:'Route local AI CLI tasks with availability fallback.',
  register(api) {
    const config=normalizeConfig({stateDir:join(homedir(),'.jijin-ai-router'),...api.pluginConfig});
    // CLI backend {sessionId} uses the host session id, so controls must persist under the same key.
    const sessionFrom=(ctx)=>ctx.sessionId || ctx.sessionKey || ctx.senderId || `${ctx.channel || ctx.channelId || 'openclaw'}:default`;
    api.registerCommand({
      name:'route',description:'查看或切换本会话使用的本机 AI',acceptsArgs:true,requireAuth:true,
      handler:async (ctx) => {
        const result=await route(config,{prompt:`/route${ctx.args ? ` ${ctx.args}` : ''}`,sessionId:sessionFrom(ctx),source:'微信 ClawBot 命令'});
        return {text:result.text};
      },
    });
    api.on('before_agent_reply',async (event,ctx) => {
      if(!parseRouteControl(config,event.cleanedBody)) return;
      const result=await route(config,{prompt:event.cleanedBody,sessionId:sessionFrom(ctx),source:'微信 ClawBot 对话控制'});
      return {handled:true,reply:{text:result.text},reason:'jijin-ai-router route control'};
    },{eligibleTriggers:['user']});
    api.registerCliBackend({
      id:'jijin-ai-router',
      liveTest:{defaultModelRef:'jijin-ai-router/auto',defaultImageProbe:false,defaultMcpProbe:false},
      config:{
      command:process.execPath,args:[fileURLToPath(new URL('./router.mjs',import.meta.url))],
      input:'stdin',output:'text',env:{JIJIN_AI_ROUTER_CONFIG:JSON.stringify(config)},serialize:true,
      sessionMode:'always',sessionArgs:['--session-id','{sessionId}'],
      },
    });
  },
});
