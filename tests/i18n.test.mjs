import test from 'node:test';
import assert from 'node:assert/strict';
import { messages } from '../shared/messages.js';
import { normalizeLocale, translate } from '../shared/i18n.js';

test('English default, Dutch regional preferences, and unsupported-language fallback', () => {
  assert.equal(normalizeLocale(undefined), 'en');
  assert.equal(normalizeLocale('NL-be'), 'nl');
  assert.equal(normalizeLocale('fr'), 'en');
  assert.equal(translate('Repo opslaan'), 'Save repository');
  assert.equal(translate('Repo opslaan', [], 'nl'), 'Repo opslaan');
});

test('all messages retain their interpolation slots in both languages', () => {
  const slots = s => [...s.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
  for (const [nl, en] of Object.entries(messages)) {
    assert.deepEqual(slots(en), slots(nl), nl);
    assert.equal(translate(nl, [], 'nl'), nl);
    assert.equal(translate(nl, [], 'en'), en);
  }
});

test('state and API messages switch language without changing inserted repository names', () => {
  const name = 'owner/repo-$&-{0}';
  const en = translate('Toegevoegd: {0}', [name], 'en');
  assert.equal(en, `Added: ${name}`);
  assert.equal(translate(en, [], 'nl'), `Toegevoegd: ${name}`);
  assert.equal(translate('Repository is not saved yet.', [], 'nl'), 'Repository is nog niet opgeslagen.');
  assert.equal(translate('Let op: poort 3000 is al in gebruik door a/b — deze start pakt mogelijk een andere poort of faalt.', [], 'en'), 'Warning: port 3000 is already in use by a/b — this start may use a different port or fail.');
  assert.equal(translate('User notes, paths, and README content stay intact.', [], 'nl'), 'User notes, paths, and README content stay intact.');
});

test('locale preference survives module reload and disabled browser storage', async () => {
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const first = await import('../src/i18n.js?first');
  assert.equal(first.getLocale(), 'en');
  first.setLocale('nl');
  assert.equal(values.get(first.LANGUAGE_STORAGE_KEY), 'nl');
  const reloaded = await import('../src/i18n.js?reloaded');
  assert.equal(reloaded.getLocale(), 'nl');
  assert.equal(reloaded.t('Repo opslaan'), 'Repo opslaan');
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const blocked = await import('../src/i18n.js?blocked');
  assert.equal(blocked.getLocale(), 'en');
  blocked.setLocale('nl');
  assert.equal(blocked.getLocale(), 'nl');
  delete globalThis.localStorage;
});
