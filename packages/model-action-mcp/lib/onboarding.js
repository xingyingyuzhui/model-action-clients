// Public, deterministic instructions. A pairing code never substitutes for the server invite.
export function onboardingView(view = {}, {serverUrl = 'https://xingying.dev', clock = Date.now} = {}) {
  if(view.onboarding_mode==='conversation') {
    const {pairing,pairing_code,lobby_url,...safe}=view;
    const phase=view.phase??'idle';
    const instructions={
      idle:['Model行动插件已加载。通过对话开始备战，不要求固定口令。首次核对配置；用户要求再来一局时，调用 arena_start 复用已确认配置。'],
      awaiting_ticket:['请用户直接在本轮对话提供 Model行动 邀请码或完整邀请链接，然后调用无参数 arena_submit_invite。不要回显、复述邀请码，不需要打开网页。'],
      access_error:['资格连接暂未完成。按 host_error 的安全错误码报告原因；网络故障可重试 arena_start 或 arena_submit_invite，不要要求用户重复公开已保存的凭证，不要读取私有文件。'],
      configuring:['首次在对话中核对昵称、形象、装备、模式和房间；已有 preferences 时沿用，仅询问缺少或要修改的项目。根据安全 options 选择，调用 arena_prepare 出简短摘要。不要重复收集已有信息。'],
      awaiting_confirmation:[`备赛方案：${view.dialogue?.summary??'请先补齐配置。'}`, '真人用户用自然语言同意即可调用 arena_confirm，不要求固定措辞或必须紧接下一条。问问题时先回答；方案不变不必重新生成。若用户改配置，先重新核对变更。模型自己不能确认。只向用户说明方案，不展示确认ID、正则或调用过程。'],
      starting:['用户已确认完整备赛方案，插件开始自动准备、排队和入场。'],
      existing_game:['服务器显示此身份已有在进行或候场的对局。未替用户重排或默认接管；使用 arena_status 查看状态，必要时由用户明确要求退出后重新备赛。'],
      stopped:['Model行动已停止，未确认方案已取消。用户要求继续或再来一局时，调用 arena_start；可沿用已确认配置，变更项才重新核对。'],
      ended:['服务器已确认本局结束。只报告真实结算，不自动开始下一局；等用户要求再来一局后，调用 arena_start 沿用已确认配置，不再重复索要游戏名或二次确认；不要自行连开。'],
    };
    return {...safe,pairing:null,plugin_loaded:true,game_name:'Model行动',browser_required:false,
      instructions:instructions[phase]??[view.native_loop?.armed?'当前已按用户确认运行，持续使用游戏工具直到服务器确认终局。':'请使用 arena_status 查看当前对话准备状态。'],
      troubleshooting:'所有准备和确认在对话中完成。不要默认引导网页配对，不要用 Bash 或文件工具读写私有身份文件；通用模型供应商错误与游戏资格、游戏服务状态分开报告。'};
  }
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
