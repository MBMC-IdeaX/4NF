import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSurface, redirectTarget } from '../../src/lib/surface.mjs';

const cases = [
  ['/', 'site', null],
  ['/app', 'rider', null],
  ['/app/wallet', 'rider', null],
  ['/app/account', 'rider', '/app/wallet'],
  ['/app/account/topup', 'rider', '/app/wallet'],
  ['/crew', 'crew', null],
  ['/crew/bus', 'crew', null],
  ['/device', 'crew', '/crew/bus'],
  ['/terminal', 'crew', '/crew/door'],
  ['/owner', 'owner', null],
  ['/owner/buses', 'owner', null],
  ['/operator', 'owner', '/owner'],
  ['/admin', 'admin', null],
  ['/inspect', 'inspect', null],
  ['/demo', 'demo', null],
  ['/nope', 'site', null],
  ['/applesauce', 'site', null],
  ['/crewcut', 'site', null],
];
for (const [path, app, redirect] of cases) {
  test(`${path} → ${app}${redirect ? ` via ${redirect}` : ''}`, () => {
    const surface = resolveSurface(path);
    assert.equal(surface.app, app);
    assert.equal(surface.redirect, redirect);
  });
}

test('the page inside an app is the rest of the path', () => {
  assert.equal(resolveSurface('/app/wallet').page, 'wallet');
  assert.equal(resolveSurface('/app').page, '');
  assert.equal(resolveSurface('/owner/buses/').page, 'buses');
  assert.equal(resolveSurface('/device').page, 'bus');
});

test('a redirect keeps the query, so an eSewa return still finishes', () => {
  assert.equal(redirectTarget({ pathname: '/app/account', search: '?data=abc', hash: '' }), '/app/wallet?data=abc');
  assert.equal(redirectTarget({ pathname: '/terminal', search: '?door=A', hash: '#x' }), '/crew/door?door=A#x');
  assert.equal(redirectTarget({ pathname: '/app', search: '', hash: '' }), null);
});
