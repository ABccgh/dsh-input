import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeKeyList,
  KEY_NAMES,
  MAX_CHORD_KEYS,
  parseKeyChord,
  resolveKeyName,
} from '../lib/keys.js';

test('字母、数字、功能键与常用别名', () => {
  assert.deepEqual(resolveKeyName('a'), { vk: 0x41, extended: false, name: 'a' });
  assert.deepEqual(resolveKeyName('Z'), { vk: 0x5a, extended: false, name: 'z' });
  assert.equal(resolveKeyName('0').vk, 0x30);
  assert.equal(resolveKeyName('9').vk, 0x39);
  assert.equal(resolveKeyName('f1').vk, 0x70);
  assert.equal(resolveKeyName('F24').vk, 0x87);
  assert.equal(resolveKeyName('return').vk, 0x0d);
  assert.equal(resolveKeyName('enter').vk, 0x0d);
  assert.equal(resolveKeyName('control').vk, 0x11);
  assert.equal(resolveKeyName('ctrl').vk, 0x11);
  assert.equal(resolveKeyName('escape').vk, 0x1b);
  assert.equal(resolveKeyName('pgup').vk, 0x21);
  assert.equal(resolveKeyName('pgdn').vk, 0x22);
  assert.equal(resolveKeyName('win').vk, 0x5b);
  assert.equal(resolveKeyName('numpad5').vk, 0x65);
  assert.equal(resolveKeyName('semicolon').vk, 0xba);
  assert.equal(resolveKeyName(',').vk, 0xbc);
  assert.equal(resolveKeyName('\\').vk, 0xdc);
  assert.equal(resolveKeyName('plus').vk, 0xbb);
});

test('扩展键自动标记 extended（方向键 / Insert / Delete / Win / 媒体键）', () => {
  for (const name of ['left', 'up', 'right', 'down', 'insert', 'delete', 'home', 'end', 'pageup', 'pagedown', 'numlock', 'printscreen', 'lwin', 'apps', 'volumeup']) {
    assert.equal(resolveKeyName(name).extended, true, `${name} 应该是扩展键`);
  }
  for (const name of ['a', 'shift', 'ctrl', 'enter', 'space', 'f12', 'comma']) {
    assert.equal(resolveKeyName(name).extended, false, `${name} 不是扩展键`);
  }
});

test('未知键名给出 E_BAD_KEY 与可用提示', () => {
  assert.throws(() => resolveKeyName('nonsense'), (error) => {
    assert.equal(error.code, 'E_BAD_KEY');
    assert.match(error.message, /无法识别/);
    assert.match(error.message, /可用键名示例/);
    return true;
  });
  assert.throws(() => resolveKeyName(''), /空键名/);
});

test('组合键：字符串、数组、单段数组三种写法一致', () => {
  const fromString = parseKeyChord('ctrl+shift+s');
  assert.deepEqual(fromString.keys.map((key) => key.vk), [0x11, 0x10, 0x53]);
  assert.equal(fromString.label, 'ctrl+shift+s');

  const fromArray = parseKeyChord(['ctrl', 'shift', 's']);
  assert.deepEqual(fromArray.keys.map((key) => key.vk), [0x11, 0x10, 0x53]);
  assert.equal(fromArray.label, 'ctrl+shift+s');

  const fromSegment = parseKeyChord(['ctrl+s']);
  assert.deepEqual(fromSegment.keys.map((key) => key.vk), [0x11, 0x53]);
});

test('组合键大小写不敏感，顺序保留', () => {
  const chord = parseKeyChord(['CTRL', 'Shift', 'S']);
  assert.deepEqual(chord.keys.map((key) => key.name), ['ctrl', 'shift', 's']);
});

test('组合键校验：重复、主键不在最后、超长、空段、加号', () => {
  assert.throws(() => parseKeyChord('ctrl+ctrl'), (error) => {
    assert.equal(error.code, 'E_BAD_KEY');
    assert.match(error.message, /重复/);
    return true;
  });
  assert.throws(() => parseKeyChord('s+ctrl'), /只能有一个主键/);
  assert.throws(() => parseKeyChord(['a', 'b']), /只能有一个主键/);
  assert.throws(() => parseKeyChord('a+b+c+d+e+f+g'), /最多 6 个键/);
  assert.throws(() => parseKeyChord('ctrl+'), /空键名/);
  assert.throws(() => parseKeyChord('ctrl++s'), /空键名/);
  assert.throws(() => parseKeyChord([]), /不能为空/);
  assert.throws(() => parseKeyChord(undefined), /缺少 keys/);
  assert.throws(() => parseKeyChord([42]), /必须是字符串/);
});

test('MAX_CHORD_KEYS 与 KEY_NAMES 表可用', () => {
  assert.equal(MAX_CHORD_KEYS, 6);
  assert.ok(KEY_NAMES.length > 120, `键名表应有足够条目，实际 ${KEY_NAMES.length}`);
  assert.ok(KEY_NAMES.includes('ctrl'));
  assert.ok(KEY_NAMES.includes('f24'));
  assert.equal(new Set(KEY_NAMES).size, KEY_NAMES.length, '键名表不应有重复');
});

test('describeKeyList 用十六进制标注扩展键', () => {
  const chord = parseKeyChord('ctrl+left');
  assert.equal(describeKeyList(chord.keys), '0x11 0x25*');
});
