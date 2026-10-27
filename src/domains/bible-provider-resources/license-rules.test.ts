import { describe, expect, it } from 'vitest';

import { LICENSE_RULE_SET_HASH, matchLicenseRule } from './license-rules';

describe('ordered license registry', () => {
  it.each([
    'All rights reserved',
    'Tous droits réservés',
    'Todos los derechos reservados',
    'Todos os direitos reservados',
    'Alle Rechte vorbehalten',
    'Tutti i diritti riservati',
    'Alle rechten voorbehouden',
    'Все права защищены',
  ])('reserves all rights for %s ahead of CC/public-domain matches', (phrase) => {
    expect(matchLicenseRule(`Creative Commons CC BY-ND. ${phrase}. Public domain.`)).toMatchObject({
      id: 'all-rights-reserved',
      priority: 10,
      decision: 'forbidden',
      matchedExcerpt: phrase,
    });
  });
  it.each([
    'Creative Commons',
    'CC BY-NC-ND 4.0',
    'CC0',
    'https://creativecommons.org/licenses/by/4.0/',
    'public domain',
    'Domaine public',
    'Dominio público',
    'Gemeinfrei',
  ])('allows %s', (notice) => {
    expect(matchLicenseRule(notice)).toMatchObject({
      id: 'creative-commons-or-public-domain',
      priority: 20,
      decision: 'allowed',
      matchedExcerpt: notice.includes('://')
        ? 'creativecommons.org/licenses'
        : notice.startsWith('CC BY')
          ? 'CC BY'
          : notice,
    });
  });
  it.each([
    'License terms are available on request',
    'some rights reserved',
    'recall rights reservedness',
    'creative commonstuff',
    'cc scripture',
    'public domainsuffix',
  ])('does not classify %s deterministically', (notice) => {
    expect(matchLicenseRule(notice)).toBeNull();
  });
  it('has a stable versioned content digest', () => {
    expect(LICENSE_RULE_SET_HASH).toMatch(/^[a-f0-9]{64}$/);
  });
});
