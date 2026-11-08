// Public, deterministic instructions. A pairing code never substitutes for the server invite.
export function onboardingView(view = {}, {serverUrl = 'https://xingying.dev', clock = Date.now} = {}) {
  const now=clock(), code=view.pairing?.user_code;
  const expiry=view.pairing?.expires_at_ms;
  const connected=view.connected===true;
  const activeCode=!connected&&typeof code==='string'&&Number.isSafeInteger(expiry)&&expiry>now;
  const browserCode=activeCode&&/^[A-F0-9]{10}$/i.test(code)?code.toUpperCase():null;
  // Fragment navigation keeps the public code out of HTTP requests/referrers.
  // Construct from the origin so no credentials or existing query can propagate.
  const lobbyUrl=new URL('/agent-arena/lobby/',new URL(serverUrl).origin);
  lobbyUrl.hash=browserCode?'pairing_code='+browserCode:'prepare';
  const guidance={
    plugin_loaded:true,
    game_name:'Model行动',
    lobby_url:lobbyUrl.href,
    invite_and_pairing_are_different:true,
    instructions:activeCode?[
      browserCode?'打开 lobby_url 的大厅配对链接；已有内测资格的浏览器会自动带入公开配对码并进入审阅。配对码不是邀请码，不能填到邀请码框。':'打开 lobby_url 进入大厅备赛。当前返回的配对码不是邀请码，不能填到邀请码框。',
      `核对“插件显示的公开配对码”与客户端后点击“批准此实例”。若未自动带入，可手动填入 ${code} 并点击“审阅请求”；若尚无内测资格，先按大厅提示完成准入，再继续配对审阅。`,
      view.active?'插件正在等待授权；批准后自动继续入场。':'当前自动入场已停止。配对修复不会自动重新游玩；批准后如需入场，请明确说“继续 Model行动”。',
    ]:connected?[view.entry_state==='in_world'?'此会话已入场，持续使用本会话游戏工具直到服务器确认终局；无需重复配对。':'此会话已配对。使用 arena_status 查看状态；停止后如需继续游戏，请明确说“继续 Model行动”。']:
      ['Model行动插件已加载。用户说“开启 Model行动插件”即可调用 arena_start，取得公开配对码。无需读取插件源码或身份文件。'],
    troubleshooting:'配对码无效时调用 arena_repair_pairing；不要把它当邀请码，不要推断服务端已作废，不要用 Bash/文件工具读取或删除私有身份文件。',
  };
  if(activeCode){guidance.pairing_code=code;guidance.expires_at_utc=new Date(expiry).toISOString();guidance.expires_in_seconds=Math.max(0,Math.ceil((expiry-now)/1000));}
  else if(code&&!connected)guidance.pairing_code_expired=true;
  return {...view,...((connected||guidance.pairing_code_expired)?{pairing:null}:{}),...guidance};
}
