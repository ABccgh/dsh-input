/**
 * 键名解析：把 `ctrl+shift+s` / `["ctrl","shift","s"]` 变成 helper 认识的 VK 码。
 *
 * 键名表放在 Node 侧而不是 PowerShell 侧：一是可以用 `node --test` 覆盖，
 * 二是 helper 能保持纯 ASCII（Windows PowerShell 5.1 无 BOM 时按 ANSI 读文件）。
 *
 * @module @local/input/keys
 */

import { inputError } from './errors.js';

/** `[别名... , VK]` 表；展开成 Map。 */
const KEY_ROWS = [
  [['backspace', 'bksp'], 0x08],
  [['tab'], 0x09],
  [['clear'], 0x0c],
  [['enter', 'return', 'ret'], 0x0d],
  [['shift'], 0x10],
  [['ctrl', 'control'], 0x11],
  [['alt', 'option'], 0x12],
  [['pause', 'break'], 0x13],
  [['capslock', 'caps'], 0x14],
  [['esc', 'escape'], 0x1b],
  [['space', 'spacebar'], 0x20],
  [['pageup', 'pgup', 'prior'], 0x21],
  [['pagedown', 'pgdn', 'next'], 0x22],
  [['end'], 0x23],
  [['home'], 0x24],
  [['left', 'arrowleft'], 0x25],
  [['up', 'arrowup'], 0x26],
  [['right', 'arrowright'], 0x27],
  [['down', 'arrowdown'], 0x28],
  [['select'], 0x29],
  [['print'], 0x2a],
  [['execute'], 0x2b],
  [['printscreen', 'prtsc', 'snapshot'], 0x2c],
  [['insert', 'ins'], 0x2d],
  [['delete', 'del'], 0x2e],
  [['help'], 0x2f],
  [['multiply'], 0x6a],
  [['add'], 0x6b],
  [['separator'], 0x6c],
  [['subtract'], 0x6d],
  [['decimal'], 0x6e],
  [['divide'], 0x6f],
  [['numlock'], 0x90],
  [['scrolllock', 'scroll'], 0x91],
  [['lshift', 'leftshift'], 0xa0],
  [['rshift', 'rightshift'], 0xa1],
  [['lctrl', 'leftctrl'], 0xa2],
  [['rctrl', 'rightctrl'], 0xa3],
  [['lalt', 'leftalt'], 0xa4],
  [['ralt', 'rightalt', 'altgr'], 0xa5],
  [['lwin', 'leftwin'], 0x5b],
  [['rwin', 'rightwin'], 0x5c],
  [['win', 'windows', 'super', 'meta', 'cmd'], 0x5b],
  [['apps', 'menu', 'contextmenu'], 0x5d],
  [['sleep'], 0x5f],
  [['volumemute', 'mute'], 0xad],
  [['volumedown', 'voldown'], 0xae],
  [['volumeup', 'volup'], 0xaf],
  [['medianexttrack', 'nexttrack'], 0xb0],
  [['mediaprevtrack', 'prevtrack'], 0xb1],
  [['mediastop', 'stopmedia'], 0xb2],
  [['mediaplaypause', 'playpause'], 0xb3],
  [['semicolon'], 0xba],
  [['equals', 'equal'], 0xbb],
  [['plus'], 0xbb],
  [['comma'], 0xbc],
  [['minus', 'dash'], 0xbd],
  [['period', 'dot'], 0xbe],
  [['slash', 'forwardslash'], 0xbf],
  [['backtick', 'grave'], 0xc0],
  [['lbracket', 'leftbracket', 'bracketleft'], 0xdb],
  [['backslash'], 0xdc],
  [['rbracket', 'rightbracket', 'bracketright'], 0xdd],
  [['quote', 'apostrophe', 'singlequote'], 0xde],
];

/** 单字符标点直接映射（`+` 是组合键分隔符，改用 `plus`）。 */
const SINGLE_CHAR_KEYS = new Map([
  [',', 0xbc],
  ['.', 0xbe],
  ['/', 0xbf],
  [';', 0xba],
  ['=', 0xbb],
  ['-', 0xbd],
  ['`', 0xc0],
  ['[', 0xdb],
  ['\\', 0xdc],
  [']', 0xdd],
  ["'", 0xde],
]);

/** 需要 KEYEVENTF_EXTENDEDKEY 的虚拟键。 */
const EXTENDED_VKS = new Set([
  0x2c, // PrintScreen
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, // PageUp/PageDown/End/Home/方向键
  0x2d, 0x2e, // Insert/Delete
  0x90, // NumLock
  0x6f, // 小键盘除号
  0xa3, 0xa5, // 右 Ctrl / 右 Alt
  0x5b, 0x5c, 0x5d, // Win 键 / 菜单键
  0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, // 媒体键
]);

/** 修饰键集合（组合键里除主键外只能出现这些）。 */
const MODIFIER_VKS = new Set([0x10, 0xa0, 0xa1, 0x11, 0xa2, 0xa3, 0x12, 0xa4, 0xa5, 0x5b, 0x5c]);

const NAMED_KEYS = new Map();
for (const [names, vk] of KEY_ROWS) {
  for (const name of names) {
    if (NAMED_KEYS.has(name) && NAMED_KEYS.get(name) !== vk) {
      throw new Error(`键名别名冲突：${name}`);
    }
    NAMED_KEYS.set(name, vk);
  }
}
for (let index = 1; index <= 24; index += 1) NAMED_KEYS.set(`f${index}`, 0x70 + index - 1);
for (let index = 0; index <= 9; index += 1) {
  NAMED_KEYS.set(`numpad${index}`, 0x60 + index);
  NAMED_KEYS.set(`num${index}`, 0x60 + index);
}
for (const index of [...Array(26).keys()]) {
  const letter = String.fromCharCode(97 + index);
  NAMED_KEYS.set(letter, 0x41 + index);
}
for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
  NAMED_KEYS.set(digit, 0x30 + Number(digit));
}
for (const [punctuation, vk] of SINGLE_CHAR_KEYS) NAMED_KEYS.set(punctuation, vk);

/** 全部可识别键名（排序后，用于文档与报错提示）。 */
export const KEY_NAMES = [...NAMED_KEYS.keys()].sort();

/** 组合键最多几个键。 */
export const MAX_CHORD_KEYS = 6;

/**
 * 给未知键名找几个近似候选。
 * @param {string} name - 用户输入。
 * @returns {string} 提示文本。
 */
function suggestions(name) {
  const lower = name.toLowerCase();
  const matched = KEY_NAMES.filter((candidate) => candidate.includes(lower) || lower.includes(candidate)).slice(0, 5);
  const list = matched.length > 0 ? matched : ['ctrl', 'shift', 'alt', 'enter', 'esc', 'a', 'f1'];
  return `可用键名示例：${list.join('、')}；字母/数字直接写 a、1，标点写 semicolon、comma、slash、period，加号写 plus。`;
}

/**
 * 解析单个键名。
 * @param {string} rawName - 键名。
 * @returns {{ vk: number, extended: boolean, name: string }} 键。
 * @throws {import('./errors.js').InputError} 无法识别时。
 */
export function resolveKeyName(rawName) {
  const name = String(rawName ?? '').trim().toLowerCase();
  if (name === '') throw inputError('E_BAD_KEY', '组合键里有空键名（例如 "ctrl+" 或 "a++b"）。加号键请写 plus。');
  const vk = NAMED_KEYS.get(name);
  if (vk === undefined) throw inputError('E_BAD_KEY', `无法识别的键名「${rawName}」。${suggestions(name)}`);
  return { vk, extended: EXTENDED_VKS.has(vk), name };
}

/**
 * 把工具参数解析成一组键（一次组合键）。
 * @param {string | string[] | undefined} value - `"ctrl+shift+s"` 或 `["ctrl","shift","s"]`。
 * @returns {{ keys: {vk:number,extended:boolean,name:string}[], label: string }} 结果。
 * @throws {import('./errors.js').InputError} 格式或键名非法时。
 */
export function parseKeyChord(value) {
  if (value === undefined || value === null) throw inputError('E_BAD_ARGS', '缺少 keys 参数。');
  const rawList = Array.isArray(value) ? value : [value];
  if (rawList.length === 0) throw inputError('E_BAD_ARGS', 'keys 不能为空。');
  const tokens = [];
  for (const item of rawList) {
    if (typeof item !== 'string') throw inputError('E_BAD_ARGS', 'keys 里的每一项都必须是字符串键名。');
    for (const piece of item.split('+')) tokens.push(piece.trim());
  }
  if (tokens.some((token) => token === '')) {
    throw inputError('E_BAD_KEY', '组合键里有空键名（例如 "ctrl+"）；加号键请写 plus。');
  }
  if (tokens.length > MAX_CHORD_KEYS) {
    throw inputError('E_BAD_KEY', `一次组合键最多 ${MAX_CHORD_KEYS} 个键，收到 ${tokens.length} 个。`);
  }
  const keys = tokens.map((token) => resolveKeyName(token));
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key.vk)) throw inputError('E_BAD_KEY', `组合键里有重复的键「${key.name}」。`);
    seen.add(key.vk);
  }
  for (let index = 0; index < keys.length - 1; index += 1) {
    if (!MODIFIER_VKS.has(keys[index].vk)) {
      throw inputError('E_BAD_KEY', `组合键里只能有一个主键，且主键放最后；「${keys[index].name}」不是修饰键。`);
    }
  }
  return { keys, label: keys.map((key) => key.name).join('+') };
}

/**
 * 把键列表渲染成文本。
 * @param {{ vk: number, name?: string }[]} keys - 键列表。
 * @returns {string} 文本。
 */
export function describeKeyList(keys) {
  return keys.map((key) => `0x${key.vk.toString(16).toUpperCase()}${key.extended ? '*' : ''}`).join(' ');
}
