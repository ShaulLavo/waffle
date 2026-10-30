import assert from 'node:assert/strict';
import { currentDateCases, dateCases, fixedTime } from '../fixtures/date-cases.ts';

const allowed = new Set(
  dateCases.filter(fixture => fixture.kind !== 'unsupported').map(fixture => JSON.stringify(fixture.args))
    .concat(currentDateCases.map(fixture => JSON.stringify(['-d', fixedTime.epoch].concat(fixture.args)))),
);
allowed.add(JSON.stringify(['--version']));

export function assertSafeNativeDateArgs(args: readonly string[]) {
  assert.ok(allowed.has(JSON.stringify(args)), 'Native GNU date accepts only the reviewed safe fixture argv or --version');
}
