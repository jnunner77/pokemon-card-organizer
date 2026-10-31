import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/owner.js is a plain browser script; load it the way the page does.
type Owner = { dotOf: (o: unknown) => string; dotTitle: (o: unknown) => string; ownerLabel: (o: unknown) => string };
const sandbox = { window: {} as { BinderOwner: Owner } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/owner.js'), 'utf8'), sandbox);
const { dotOf, dotTitle, ownerLabel } = sandbox.window.BinderOwner;

describe('dotOf', () => {
  it.each([
    ['Justin', 'red'], ['Maiya', 'green'], ['Both', 'half'],
    [' justin ', 'red'], ['MAIYA', 'green'], ['both', 'half'],
    ['Megan', ''], ['', ''], [undefined, ''], [null, ''], [42, ''],
    ['constructor', ''], ['toString', ''], ['Sam', ''],
  ])('%j -> %j', (owner, dot) => expect(dotOf(owner)).toBe(dot));
});

describe('dotTitle', () => {
  it.each([
    ['Justin', "Justin's card"], ['maiya', "Maiya's card"], ['Both', "Megan and Justin's card"],
    ['Megan', ''], ['', ''], ['constructor', ''],
  ])('%j -> %j', (owner, title) => expect(dotTitle(owner)).toBe(title));
});

describe('ownerLabel', () => {
  it.each([
    ['Megan', "Megan's"], ['Both', "Megan and Justin's"], ['Justin', "Justin's"], ['Maiya', "Maiya's"],
    ['', ''], [undefined, ''], ['constructor', ''],
  ])('%j -> %j', (owner, label) => expect(ownerLabel(owner)).toBe(label));
});
