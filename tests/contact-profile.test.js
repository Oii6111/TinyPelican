'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildContactProfilePrompt, isProfileConclusion } = require('../core/engine/prompts/contact-profile');

test('画像提示词区分本人、用户和第三人，复用字段名称而不把旧画像当事实', () => {
  const prompt = buildContactProfilePrompt({
    name: '๓樱凌๓', remark: '阮嘉奕',
    profile: { 基础身份: { '职业/学业': '错误的用户开发情况' }, 商业价值: { 自由业务字段: '另一条旧的错误情况' } }
  });
  assert.ok(prompt.includes('๓樱凌๓') && prompt.includes('阮嘉奕'));
  assert.ok(prompt.includes('自由业务字段'));
  assert.ok(!prompt.includes('错误的用户开发情况') && !prompt.includes('另一条旧的错误情况'));
  assert.match(prompt, /关于用户或第三人的情况不能写成联系人本人的属性/);
  assert.match(prompt, /转述、引用、转发、玩笑、假设/);
  assert.match(prompt, /归属不明确就不提取/);
  assert.match(prompt, /不推断人格、依恋类型、心理诊断、性取向和关系风险/);
  assert.match(prompt, /学生\/医学方向\/实习中/);
  assert.match(prompt, /依据只放在 messageIds/);
  assert.match(prompt, /value 不附聊天日期/);
});

test('画像结论校验拒绝证据叙述和超长内容，保留合法日期与关键词', () => {
  for (const value of ['学生/医学方向/实习中', '散步、电影', '09-14', '2026-12-20', '不喜欢突然来电', '原话'.repeat(30)]) {
    assert.equal(isProfileConclusion(value), true, value);
  }
  for (const value of ['', ' ', null, {}, '长'.repeat(61), '2026-09-14表示在骨科实习', '提到新科室和带教', '根据聊天推测是学生', '学生（证据：学业聊天）']) {
    assert.equal(isProfileConclusion(value), false, String(value));
  }
});
