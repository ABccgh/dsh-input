import assert from 'node:assert/strict';
import test from 'node:test';

import {
  containsPoint,
  describeRect,
  normalizeSpace,
  resolveDelta,
  resolvePoint,
  resolveRegion,
  toInteger,
  toLogicalPoint,
} from '../lib/coordinates.js';

const SCREEN = {
  physical: { x: 0, y: 0, width: 1920, height: 1080 },
  logical: { width: 1536, height: 864 },
  scale: 1.25,
};

test('toInteger 接受数字与数字字符串，拒绝空值/非数字', () => {
  assert.equal(toInteger(12, 'x'), 12);
  assert.equal(toInteger('12.9', 'x'), 12);
  assert.equal(toInteger('-3', 'x'), -3);
  assert.throws(() => toInteger(undefined, 'x'), /缺少参数 x/);
  assert.throws(() => toInteger(null, 'y'), /缺少参数 y/);
  assert.throws(() => toInteger('abc', 'z'), /必须是数字/);
  assert.throws(() => toInteger(Number.NaN, 'z'), /必须是数字/);
});

test('normalizeSpace 只接受 physical / logical', () => {
  assert.equal(normalizeSpace(undefined, 'physical'), 'physical');
  assert.equal(normalizeSpace('LOGICAL', 'physical'), 'logical');
  assert.equal(normalizeSpace(' physical ', 'logical'), 'physical');
  assert.throws(() => normalizeSpace('screen', 'physical'), /只能/);
});

test('containsPoint / describeRect', () => {
  assert.equal(containsPoint(SCREEN.physical, { x: 0, y: 0 }), true);
  assert.equal(containsPoint(SCREEN.physical, { x: 1919, y: 1079 }), true);
  assert.equal(containsPoint(SCREEN.physical, { x: 1920, y: 1079 }), false);
  assert.equal(containsPoint(SCREEN.physical, { x: -1, y: 0 }), false);
  assert.equal(describeRect(SCREEN.physical), '(0, 0) 起 1920×1080');
});

test('toLogicalPoint 按主屏缩放换算，非法 scale 回退 1', () => {
  assert.deepEqual(toLogicalPoint({ x: 1200, y: 675 }, SCREEN), { x: 960, y: 540 });
  assert.deepEqual(toLogicalPoint({ x: 10, y: 20 }, { scale: 0 }), { x: 10, y: 20 });
  assert.deepEqual(toLogicalPoint({ x: 10, y: 20 }, {}), { x: 10, y: 20 });
});

test('resolvePoint：物理原样、逻辑缩放、越界报 E_BOUNDS', () => {
  const physical = resolvePoint({ x: 10, y: 20 }, { screen: SCREEN });
  assert.deepEqual(physical, { space: 'physical', requested: { x: 10, y: 20 }, physical: { x: 10, y: 20 } });

  const logical = resolvePoint({ x: 960, y: 540, space: 'logical' }, { screen: SCREEN });
  assert.deepEqual(logical.physical, { x: 1200, y: 675 });
  assert.deepEqual(logical.requested, { x: 960, y: 540 });

  assert.throws(() => resolvePoint({ x: 2000, y: 10 }, { screen: SCREEN }), (error) => {
    assert.equal(error.code, 'E_BOUNDS');
    assert.match(error.message, /1920×1080/);
    return true;
  });
  const allowed = resolvePoint({ x: 2000, y: 10 }, { screen: SCREEN, allowOutOfBounds: true });
  assert.deepEqual(allowed.physical, { x: 2000, y: 10 });
});

test('resolvePoint：逻辑坐标越界也按物理边界判断', () => {
  assert.throws(() => resolvePoint({ x: 1536, y: 0, space: 'logical' }, { screen: SCREEN }), /E_BOUNDS|超出屏幕/);
});

test('resolveDelta 解析相对位移', () => {
  assert.deepEqual(resolveDelta({ dx: 5, dy: -3 }), { x: 5, y: -3 });
  assert.throws(() => resolveDelta({ dx: 5 }), /缺少参数 dy/);
});

test('resolveRegion：未指定返回 undefined，物理/逻辑换算，越界与尺寸校验', () => {
  assert.equal(resolveRegion({}, { screen: SCREEN }), undefined);

  assert.deepEqual(
    resolveRegion({ region: { x: 10, y: 20, width: 100, height: 50 } }, { screen: SCREEN }),
    { x: 10, y: 20, width: 100, height: 50 },
  );

  assert.deepEqual(
    resolveRegion({ region: { x: 100, y: 100, width: 200, height: 100 }, space: 'logical' }, { screen: SCREEN }),
    { x: 125, y: 125, width: 250, height: 125 },
  );

  assert.throws(() => resolveRegion({ region: { x: 10, y: 10, width: 0, height: 10 } }, { screen: SCREEN }), /width\/height/);
  assert.throws(() => resolveRegion({ region: { x: 1900, y: 0, width: 100, height: 100 } }, { screen: SCREEN }), /超出屏幕/);
  assert.throws(() => resolveRegion({ region: 'x' }, { screen: SCREEN }), /region 必须/);
  assert.throws(() => resolveRegion({ region: { x: 0, y: 0, width: 10 } }, { screen: SCREEN }), /缺少参数 region\.height/);
});

test('多屏虚拟原点：负坐标按虚拟屏判断', () => {
  const multi = {
    physical: { x: -1920, y: 0, width: 3840, height: 1080 },
    logical: { width: 3072, height: 864 },
    scale: 1.25,
  };
  assert.deepEqual(resolvePoint({ x: -1920, y: 0 }, { screen: multi }).physical, { x: -1920, y: 0 });
  assert.throws(() => resolvePoint({ x: -1921, y: 0 }, { screen: multi }), /超出屏幕/);
  assert.deepEqual(
    resolveRegion({ region: { x: -1920, y: 0, width: 1920, height: 1080 } }, { screen: multi }),
    { x: -1920, y: 0, width: 1920, height: 1080 },
  );
});
