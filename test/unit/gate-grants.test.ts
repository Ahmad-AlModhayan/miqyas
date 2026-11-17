// SPDX-License-Identifier: AGPL-3.0-only
// Grants: a value built only from command-line flags, or from the already-parsed content of a file a person wrote.

import { describe, expect, it } from 'vitest';
import { GrantsError, grantsFromFile, grantsFromFlags, isIssuedGrants, noGrants } from '../../src/gate/decide/index.js';

describe('grants from command-line flags', () => {
  it('are empty when no grant flag is given, and other flags are not grants', () => {
    const expected = { active: false, allowWrites: false, allowDisrupt: false, allowExec: false, allowHosts: [] };
    expect(grantsFromFlags([])).toMatchObject(expected);
    expect(grantsFromFlags(['--url', 'http://localhost:3000', '--fail-on', 'none'])).toMatchObject(expected);
    expect(noGrants()).toMatchObject(expected);
  });

  it('hold --active, --allow-writes, --allow-disrupt and --allow-exec, each by itself', () => {
    expect(grantsFromFlags(['--active'])).toMatchObject({ active: true, allowWrites: false, allowDisrupt: false });
    expect(grantsFromFlags(['--allow-writes'])).toMatchObject({ active: false, allowWrites: true });
    expect(grantsFromFlags(['--allow-disrupt'])).toMatchObject({ active: false, allowDisrupt: true });
    expect(grantsFromFlags(['--allow-exec'])).toMatchObject({ allowExec: true, allowDisrupt: false });
  });

  it('hold the hosts named with --allow-host, lower-cased, in either spelling of the flag', () => {
    expect(grantsFromFlags(['--allow-host', 'Staging.Example.com', '--allow-host=api.example.com']).allowHosts).toEqual([
      'staging.example.com',
      'api.example.com',
    ]);
  });

  it('refuse a flag that grants something this module does not know, and a host that is not a bare host name', () => {
    expect(() => grantsFromFlags(['--allow-everything'])).toThrow(GrantsError);
    expect(() => grantsFromFlags(['--allow-host'])).toThrow(GrantsError);
    expect(() => grantsFromFlags(['--allow-host', '--active'])).toThrow(GrantsError);
    expect(() => grantsFromFlags(['--allow-host', 'https://victim.example/path'])).toThrow(GrantsError);
    expect(() => grantsFromFlags(['--allow-host', 'victim.example:8080'])).toThrow(GrantsError);
  });
});

describe('grants from the parsed content of a file a person wrote', () => {
  it('hold what the file sets', () => {
    expect(
      grantsFromFile({ active: true, allowWrites: true, allowHosts: ['Staging.Example.com'] }),
    ).toMatchObject({ active: true, allowWrites: true, allowDisrupt: false, allowExec: false, allowHosts: ['staging.example.com'] });
    expect(grantsFromFile({})).toMatchObject({ active: false, allowHosts: [] });
  });

  it('refuse anything that is not a plain object of the known keys with the right types', () => {
    for (const bad of [null, 'active', ['active'], 42, { active: 'yes' }, { allowHosts: 'a.example' }, { allowHosts: [1] }, { admin: true }, { allowHosts: ['a/b'] }]) {
      expect(() => grantsFromFile(bad)).toThrow(GrantsError);
    }
  });
});

describe('a grants value', () => {
  it('is frozen, so a caller cannot widen it after it was built', () => {
    const g = grantsFromFlags(['--active']);
    expect(Object.isFrozen(g)).toBe(true);
    expect(Object.isFrozen(g.allowHosts)).toBe(true);
  });

  it('is recognised as issued only when one of the builders made it', () => {
    expect(isIssuedGrants(grantsFromFlags(['--active']))).toBe(true);
    expect(isIssuedGrants(grantsFromFile({ active: true }))).toBe(true);
    expect(isIssuedGrants(noGrants())).toBe(true);
    const forged = { active: true, allowWrites: true, allowDisrupt: true, allowExec: true, allowHosts: ['victim.example'] };
    expect(isIssuedGrants(forged)).toBe(false);
    expect(isIssuedGrants({ ...grantsFromFlags(['--active']) })).toBe(false);
    expect(isIssuedGrants(null)).toBe(false);
  });
});
