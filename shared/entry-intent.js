// Opening preparation is harmless; this policy only decides whether a current
// human message also requests a match using an already reviewed configuration.
// The caller authenticates message provenance. Never pass assistant/tool text here.
const textOf = value => String(value ?? '').normalize('NFKC').trim();
const explicitStop = /(?:不要|别|勿|禁止|不想|不再|先不|暂不|还不|不可以|不能|不用|不急|晚点|稍后).{0,8}(?:开始|开局|开打|开战|启动|开启|打开|入场|加入|继续玩|再玩|再来|再跑)|^不(?:开始|开局|玩|打)|^(?:等等|等一下|稍等)|(?:取消|停止|停下|暂停)(?:吧|了|一下|游戏|比赛|对局|这局)?$|\b(?:do\s+not|don't|never)\s+(?:start|play|join|open|enable)|\b(?:stop|cancel|pause)\b/i;
const commentary = /为什么|为何|什么意思|怎么(?:才能|才|还|又|开始|开局)|如何|是否需要|什么时候|(?:开始|开局|入场).{0,4}(?:了吗|没有|了没)|准备好了吗|告诉我|多少钱|问一下|介绍|说明|复盘|继续(?:说|讲|解释|分析)|必须|门禁|正则|授权条件|他说|她说|它说|例如|举例|翻译|解释|(?:he|she|it)\s+said|\b(?:explain|translate|example)\b/i;
const playRequest = /开始|开局|开打|开战|入场|再(?:来|跑|玩|打|试)(?:(?:一|两|几|[0-9]+)(?:次|局|轮|把|盘)|(?:次|局|轮|把|盘))|下一(?:局|轮|把|盘)|继续(?:玩|打|游戏|比赛)|重开|^(?:再来|继续|走起|出发|开搞)(?:吧|呀|啊)?[。！!？?\s]*$|\b(?:start|play|join|rematch|another\s+(?:game|round|match))\b/i;
const affirmation = /^(?:嗯|好(?:的|啊|呀|吧)?|行|可以|没问题|确认|同意|就这样|按(?:这|上面|原来|上次).{0,8}来|yes\b|ok(?:ay)?\b|sure\b|confirmed?\b)/i;
const reviewRequest = /等(?:我|用户|确认|通知)|(?:先|让我).{0,8}(?:看|核对|确认|问|选|了解).{0,8}(?:配置|方案|形象|装备)|(?:确认|看过|核对).{0,6}(?:之后|以后|后)再/i;
const configField = '(?:形象|角色|装备|武器|名字|名称|昵称|模式|房间|娘|步枪|冲锋枪|霰弹枪)';
const change = new RegExp('(?:换|改|调整|选|切|变更|不要用|不再用|不用).{0,16}' + configField + '|' + configField + '.{0,12}(?:换|改|调整|选|切|变更)|' + configField + '\\s*(?:叫|用|选|为|设|[=:：])|(?:改成|换成|改为|换为|改名|起名|叫我)', 'i');
const unchanged = /(?:形象|角色|装备|武器|名字|名称|昵称|模式|房间|配置|方案)(?:都|全部)?(?:不变|不用改|不要改|保持原样)|(?:不用|不要|不必|不|无需|别)(?:更换|修改|换|改)(?:形象|角色|装备|武器|名字|名称|昵称|模式|房间|配置)|(?:沿用|照用|保留|还是)(?:上局|上轮|上一局|上次|原来|这套|原有)(?:的)?(?:配置|方案|装备|形象)?/g;

export function entryIntent(value, { catalog, entry } = {}) {
  const text = textOf(value);
  const intentText = text.replace(unchanged, '');
  // Clause-local negatives do not confuse tactical instructions such as
  // "别太早撤离，再来一轮" with a request to stop playing.
  const clauses = intentText.split(/[，,。；;！!\n]/).map(v => v.trim()).filter(Boolean);
  const stopped = clauses.some(clause => explicitStop.test(clause));
  const quoted = /[“「『`]|"[^"]+"|'[^']+'/.test(text);
  const discussed = commentary.test(text) || quoted;
  let configurationTouched = change.test(intentText);
  if (entry && catalog) {
    const fields = [['characters', 'character_id'], ['loadouts', 'loadout_id'], ['modes', 'mode_id'], ['rooms', 'room_id']];
    for (const [list, field] of fields) {
      const mentions = [];
      for (const option of catalog[list] ?? []) {
        const aliases = [option.name, option.id, option.name?.replace(/标准配置|标准|配置|\s+/g, '')].filter(v => typeof v === 'string' && v.length >= 2);
        for (const alias of aliases) if (text.toLowerCase().includes(alias.toLowerCase())) mentions.push({ id: option.id, length: alias.length });
      }
      // Prefer specific catalog names: "步枪防护" must not accidentally match
      // the shorter "步枪" label belonging to another loadout.
      const longest = Math.max(0, ...mentions.map(m => m.length));
      if (mentions.some(m => m.length === longest && m.id !== entry[field])) configurationTouched = true;
    }
  }
  // Asking what can be selected does not revoke a reviewed choice. A request
  // to switch and then play still needs a new proposal, even when phrased politely.
  const targetedChange = /换成|改成|改为|选为|换为/.test(intentText);
  const configurationQuestion = configurationTouched && !targetedChange && /[?？]|吗|么|什么|多少|哪(?:个|种|套|里|些)|如何|怎么|能否|可否/.test(text) && !playRequest.test(text);
  const configurationChanged = configurationTouched && !configurationQuestion;
  const reviewOnly = reviewRequest.test(text);
  const allowed = !!text && !stopped && !discussed && !configurationChanged && !configurationQuestion && !reviewOnly;
  return {
    stopped, configurationChanged, reviewOnly,
    // Polite questions such as "再来一局？" are requests. Discussion about
    // confirmation rules or a quoted command is not fresh play intent.
    play: allowed && playRequest.test(text),
    confirm: allowed && (playRequest.test(text) || affirmation.test(text)),
  };
}
