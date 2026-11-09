import test from 'node:test';
import assert from 'node:assert/strict';
import { entryIntent } from '../shared/entry-intent.js';

test('fresh play intent is separate from agreement and from tactical instructions',()=>{
  for(const value of ['再跑一轮实时','要多拿点钱再去撤离，再来一轮，确认开始','别太早撤离，再来一局','走起','出发吧','下一局多拿点钱','继续玩','another round'])
    assert.equal(entryIntent(value).play,true,value);
  for(const value of ['好的','知道了','确认','继续说','再来点建议','开始复盘','开始了吗？','什么时候开始？','解释一下“确认开始”','他说确认','先不开始','不开始','等等，再来一局'])
    assert.equal(entryIntent(value).play,false,value);
  assert.equal(entryIntent('好的，多拿点钱再撤离').confirm,true);
  assert.equal(entryIntent('确认但先别开始').confirm,false);
  assert.equal(entryIntent('好，告诉我这套装备多少钱').confirm,false);
});

test('configuration changes pause entry while explicit unchanged settings remain reusable',()=>{
  for(const value of ['换个形象再来一局','昵称叫小鱼，开始吧','模式换成大逃杀再开局','装备选冲锋枪，开始','改名小鱼再来一局']){
    const intent=entryIntent(value);assert.equal(intent.configurationChanged,true,value);assert.equal(intent.play,false,value);
  }
  assert.equal(entryIntent('沿用上局配置再来一轮').play,true);
  assert.equal(entryIntent('装备不用改，开始吧').play,true);
  assert.equal(entryIntent('不用换形象再来一局').play,true);
  for(const question of ['可以选择形象吗？','冲锋枪配置和步枪配置哪个好？'])
    assert.equal(entryIntent(question).configurationChanged,false,question);
  const catalog={loadouts:[{id:'rifle',name:'步枪标准配置'},{id:'smg',name:'冲锋枪标准配置'},{id:'armored',name:'步枪防护配置'}]};
  assert.equal(entryIntent('这次用冲锋枪再来一局',{catalog,entry:{loadout_id:'rifle'}}).configurationChanged,true);
  assert.equal(entryIntent('用步枪防护开一局',{catalog,entry:{loadout_id:'rifle'}}).configurationChanged,true);
  assert.equal(entryIntent('还是步枪，再来一轮',{catalog,entry:{loadout_id:'rifle'}}).play,true);
  assert.equal(entryIntent('还是步枪防护，再来一轮',{catalog,entry:{loadout_id:'armored'}}).play,true);
  for(const value of ['等我确认后再开始','先看看配置，再开始'])assert.equal(entryIntent(value).play,false,value);
  for(const value of ['可以换成Qwen娘吗？','装备能改成冲锋枪吗？'])assert.equal(entryIntent(value).configurationChanged,true,value);
});

test('natural stopping phrases are distinct from tactical or quoted discussion', async () => {
  const {humanStopIntent} = await import('../shared/entry-intent.js');
  for (const text of ['别玩了','先不玩','不玩了','停一下','停止游戏','先暂停一下','停止','先别打了','先停一下，告诉我现在状态'])
    assert.equal(humanStopIntent(text).stopped, true, text);
  for (const text of ['别太早撤离，再来一轮','别打那扇门','不要停，继续玩','请翻译 stop game','他说“停止游戏”','stop writing','解释一下停止游戏的意思'])
    assert.equal(humanStopIntent(text).stopped, false, text);
  for(const text of ['退出这局','退出游戏吧','别玩了，退出这局','先不玩，放弃本局','stop game, quit the match'])
    assert.deepEqual(humanStopIntent(text),{stopped:true,abandon:true},text);
  assert.deepEqual(humanStopIntent('停一下'),{stopped:true,abandon:false});
});

test('information questions do not authorize stops and natural refusal suffixes do',async()=>{
  const {humanStopIntent}=await import('../shared/entry-intent.js');
  for(const text of ['如何停止游戏','怎么退出游戏','有没有办法退出游戏','请问怎么退出游戏？','告诉我如何停止游戏','停止游戏会怎么样','How do I stop the game?','Is there a way to quit the match?'])
    assert.deepEqual(humanStopIntent(text),{stopped:false,abandon:false},text);
  for(const text of ['别玩了吧','不要再打了','算了不玩了吧','先别再玩了吧','不玩了吧','无论如何先停一下','不管怎么样都别玩了'])
    assert.deepEqual(humanStopIntent(text),{stopped:true,abandon:false},text);
  assert.deepEqual(humanStopIntent('停一下，告诉我怎么退出游戏'),{stopped:true,abandon:false});
  assert.deepEqual(humanStopIntent('怎么停止游戏？退出这局'),{stopped:true,abandon:true});
  assert.deepEqual(humanStopIntent('退出这局，告诉我怎么开始下一局'),{stopped:true,abandon:true});
});
