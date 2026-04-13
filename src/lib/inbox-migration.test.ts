import { describe, expect, it } from 'vitest';

import {
  mapLegacyShaping,
  mapLegacyStatus,
  upgradeLegacyInbox,
  upgradeLegacyInboxItem,
} from '@/lib/inbox-migration';

const NOW = 1_700_000_000_000;
let counter = 0;
const idGen = () => `id-${++counter}`;
const resetIds = () => {
  counter = 0;
};

describe('mapLegacyStatus', () => {
  it('maps open → new', () => {
    expect(mapLegacyStatus('open')).toBe('new');
  });
  it('maps deferred → later', () => {
    expect(mapLegacyStatus('deferred')).toBe('later');
  });
  it('maps iceboxed → later', () => {
    expect(mapLegacyStatus('iceboxed')).toBe('later');
  });
  it('drops done by returning null', () => {
    expect(mapLegacyStatus('done')).toBeNull();
  });
  it('defaults unknown/missing to new', () => {
    expect(mapLegacyStatus(undefined)).toBe('new');
    expect(mapLegacyStatus('bogus')).toBe('new');
  });
});

describe('mapLegacyShaping', () => {
  it('returns undefined for missing or empty shaping', () => {
    expect(mapLegacyShaping(undefined)).toBeUndefined();
    expect(mapLegacyShaping({})).toBeUndefined();
  });

  it('maps doneLooksLike → outcome and outOfScope → notDoing', () => {
    const result = mapLegacyShaping({
      doneLooksLike: 'SSO works.',
      appetite: 'small',
      outOfScope: 'Custom themes.',
    });
    expect(result).toEqual({ outcome: 'SSO works.', appetite: 'small', notDoing: 'Custom themes.' });
  });

  it('defaults appetite to medium when invalid but outcome is present', () => {
    const result = mapLegacyShaping({ doneLooksLike: 'Do it.', appetite: 'xl' });
    expect(result).toEqual({ outcome: 'Do it.', appetite: 'medium' });
  });

  it('omits notDoing when blank', () => {
    const result = mapLegacyShaping({ doneLooksLike: 'x', outOfScope: '   ' });
    expect(result?.notDoing).toBeUndefined();
  });

  it('is defensive about non-string fields', () => {
    const result = mapLegacyShaping({ doneLooksLike: 123, outOfScope: null, appetite: 'small' });
    expect(result).toEqual({ outcome: '', appetite: 'small' });
  });
});

describe('upgradeLegacyInboxItem', () => {
  it('drops done items', () => {
    resetIds();
    expect(upgradeLegacyInboxItem({ status: 'done', title: 'x' }, NOW, idGen)).toBeNull();
  });

  it('upgrades an open unshaped item to status=new', () => {
    resetIds();
    const item = upgradeLegacyInboxItem(
      { id: 'a1', title: 'Capture', status: 'open', createdAt: 100, updatedAt: 200 },
      NOW,
      idGen
    );
    expect(item).toEqual({
      id: 'a1',
      title: 'Capture',
      status: 'new',
      projectId: null,
      createdAt: 100,
      updatedAt: 200,
    });
  });

  it('upgrades an open shaped item to status=shaped', () => {
    resetIds();
    const item = upgradeLegacyInboxItem(
      {
        id: 'a1',
        title: 'Do thing',
        status: 'open',
        shaping: { doneLooksLike: 'Ship it.', appetite: 'small' },
        createdAt: 1,
        updatedAt: 2,
      },
      NOW,
      idGen
    );
    expect(item?.status).toBe('shaped');
    expect(item?.shaping).toEqual({ outcome: 'Ship it.', appetite: 'small' });
  });

  it('upgrades iceboxed to later and stamps laterAt from updatedAt', () => {
    resetIds();
    const item = upgradeLegacyInboxItem(
      { id: 'a1', title: 'Later thing', status: 'iceboxed', updatedAt: 999, createdAt: 1 },
      NOW,
      idGen
    );
    expect(item?.status).toBe('later');
    expect(item?.laterAt).toBe(999);
  });

  it('carries description → note and projectId', () => {
    resetIds();
    const item = upgradeLegacyInboxItem(
      {
        id: 'a1',
        title: 't',
        status: 'open',
        description: '  some detail  ',
        projectId: 'p1',
        createdAt: 1,
        updatedAt: 2,
      },
      NOW,
      idGen
    );
    expect(item?.note).toBe('some detail');
    expect(item?.projectId).toBe('p1');
  });

  it('carries attachments when they are all strings', () => {
    resetIds();
    const item = upgradeLegacyInboxItem(
      { id: 'a1', title: 't', status: 'open', attachments: ['a.png', 'b.pdf'], createdAt: 1, updatedAt: 2 },
      NOW,
      idGen
    );
    expect(item?.attachments).toEqual(['a.png', 'b.pdf']);
  });

  it('mints an id when the legacy record has none', () => {
    resetIds();
    const item = upgradeLegacyInboxItem({ title: 't', status: 'open' }, NOW, idGen);
    expect(item?.id).toBe('id-1');
  });

  it('defaults missing title to "Untitled"', () => {
    resetIds();
    const item = upgradeLegacyInboxItem({ status: 'open' }, NOW, idGen);
    expect(item?.title).toBe('Untitled');
  });
});

describe('upgradeLegacyInbox (batch)', () => {
  it('preserves order and drops done items', () => {
    resetIds();
    const items = upgradeLegacyInbox(
      [
        { id: '1', title: 'a', status: 'open' },
        { id: '2', title: 'b', status: 'done' },
        { id: '3', title: 'c', status: 'iceboxed', updatedAt: 500 },
      ],
      NOW,
      idGen
    );
    expect(items.map((i) => i.id)).toEqual(['1', '3']);
    expect(items[1].status).toBe('later');
    expect(items[1].laterAt).toBe(500);
  });
});
