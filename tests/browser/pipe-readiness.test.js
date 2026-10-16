import { expect, test } from 'bun:test';
import { SharedPipe, wasiPipe } from '../src/subprocess.js';

test('existing shared pipe exposes empty, data, full, and hang-up readiness without consuming bytes', () => {
  const pipe = new SharedPipe();
  expect(pipe.readiness()).toEqual({ readable: false, writable: true, hangup: false, nbytes: 0 });
  pipe.write(new Uint8Array([1, 2, 3]));
  expect(pipe.readiness().nbytes).toBe(3);
  expect(pipe.readiness().nbytes).toBe(3);
  pipe.close();
  expect(pipe.readiness()).toEqual({ readable: true, writable: false, hangup: true, nbytes: 3 });
});
test('WASI pipe adapter scatters input and preserves output chunk order', () => {
  const pipe = new SharedPipe();
  const output = wasiPipe(pipe, 'write');
  expect(output.write([new Uint8Array([1, 2]), new Uint8Array([3])])).toBe(3);
  const input = wasiPipe(pipe, 'read');
  const a = new Uint8Array(2), b = new Uint8Array(2);
  expect(input.read([a, b])).toBe(3);
  expect(Array.from(a).concat(Array.from(b))).toEqual([1, 2, 3, 0]);
  expect(input.readiness().readable).toBe(false);
  expect(input.read([])).toBe(0);
});
