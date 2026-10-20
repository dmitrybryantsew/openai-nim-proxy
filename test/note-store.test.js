const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { NoteStore } = require('../src/note-store');

describe('NoteStore Delta Sync Tests', () => {
  let dbFile;
  let store;

  beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-store-test-'));
    dbFile = path.join(tempDir, 'test-notes.sqlite');
    store = new NoteStore(dbFile);
  });

  test('PC uploads new notes and updates server', () => {
    const note1 = {
      path: 'Projects/Alpha.md',
      content: '# Project Alpha\nDetails here',
      hash: NoteStore.hashContent('# Project Alpha\nDetails here'),
      mtime: 1000,
      size: 30,
    };

    // Initial manifest from PC - server is empty
    const delta1 = store.computeDelta({
      deviceRole: 'pc',
      files: [note1],
    });

    assert.deepEqual(delta1.toUpload, ['Projects/Alpha.md']);
    assert.deepEqual(delta1.toDownload, []);
    assert.deepEqual(delta1.toDelete, []);

    // PC pushes note1
    const pushRes = store.upsertNotes({
      notes: [note1],
      deviceRole: 'pc',
    });
    assert.equal(pushRes.saved, 1);

    // Second manifest from PC with same note -> nothing to upload or download
    const delta2 = store.computeDelta({
      deviceRole: 'pc',
      files: [note1],
    });
    assert.deepEqual(delta2.toUpload, []);
    assert.deepEqual(delta2.toDownload, []);

    // PC modifies note1
    const note1Mod = {
      ...note1,
      content: '# Project Alpha\nUpdated details',
      hash: NoteStore.hashContent('# Project Alpha\nUpdated details'),
      mtime: 2000,
    };
    const delta3 = store.computeDelta({
      deviceRole: 'pc',
      files: [note1Mod],
    });
    assert.deepEqual(delta3.toUpload, ['Projects/Alpha.md']);
  });

  test('PC deletion creates tombstone on server', () => {
    const note1 = {
      path: 'Projects/Beta.md',
      content: 'Beta content',
      hash: NoteStore.hashContent('Beta content'),
    };
    store.upsertNotes({ notes: [note1], deviceRole: 'pc' });

    // PC syncs but note1 was deleted locally (empty files array)
    const delta = store.computeDelta({
      deviceRole: 'pc',
      files: [],
    });

    // Server should mark note1 as deleted
    const stats = store.getStats();
    assert.equal(stats.activeNotes, 0);
    assert.equal(stats.deletedNotes, 1);

    // Pulling it returns empty
    const pulled = store.getNotesByPaths({ paths: ['Projects/Beta.md'] });
    assert.equal(pulled.length, 0);
  });

  test('Mobile downloads missing notes from PC', () => {
    const note1 = {
      path: 'Daily/2026-10-20.md',
      content: 'Morning tasks',
      hash: NoteStore.hashContent('Morning tasks'),
    };
    store.upsertNotes({ notes: [note1], deviceRole: 'pc' });

    // Mobile syncs with empty local vault
    const delta = store.computeDelta({
      deviceRole: 'mobile',
      files: [],
    });

    assert.deepEqual(delta.toDownload, ['Daily/2026-10-20.md']);
    assert.deepEqual(delta.toUpload, []);
    assert.deepEqual(delta.toDelete, []);

    // Mobile pulls the content
    const pulled = store.getNotesByPaths({ paths: delta.toDownload });
    assert.equal(pulled.length, 1);
    assert.equal(pulled[0].content, 'Morning tasks');
  });

  test('Mobile creates new note -> pushed to server -> ingested by PC', () => {
    const mobileNote = {
      path: 'Quick/Idea.md',
      content: 'Flash of inspiration on the go',
      hash: NoteStore.hashContent('Flash of inspiration on the go'),
      mtime: 5000,
      size: 32,
    };

    // Mobile delta check
    const mobileDelta = store.computeDelta({
      deviceRole: 'mobile',
      files: [mobileNote],
    });
    assert.deepEqual(mobileDelta.toUpload, ['Quick/Idea.md']);

    // Mobile pushes the new note
    store.upsertNotes({
      notes: [mobileNote],
      deviceRole: 'mobile',
    });

    // PC syncs (PC does not have Quick/Idea.md yet)
    const pcDelta = store.computeDelta({
      deviceRole: 'pc',
      files: [], // PC has no files yet
    });

    // PC should detect that a mobile-created note needs to be downloaded!
    assert.deepEqual(pcDelta.toDownload, ['Quick/Idea.md']);

    // PC pulls note
    const pcPulled = store.getNotesByPaths({ paths: pcDelta.toDownload });
    assert.equal(pcPulled.length, 1);
    assert.equal(pcPulled[0].sourceRole, 'mobile');
    assert.equal(pcPulled[0].content, 'Flash of inspiration on the go');
  });

  test('Mobile conflict detection when existing file was edited on phone', () => {
    // Note created on PC
    const originalNote = {
      path: 'Notes/Ideas.md',
      content: 'PC original ideas',
      hash: NoteStore.hashContent('PC original ideas'),
    };
    store.upsertNotes({ notes: [originalNote], deviceRole: 'pc' });

    // Mobile edited it locally before syncing
    const mobileEditedNote = {
      path: 'Notes/Ideas.md',
      content: 'Mobile quick addition',
      hash: NoteStore.hashContent('Mobile quick addition'),
    };

    const delta = store.computeDelta({
      deviceRole: 'mobile',
      files: [mobileEditedNote],
    });

    // Should tell mobile to download server's version AND flag conflict
    assert.deepEqual(delta.toDownload, ['Notes/Ideas.md']);
    assert.deepEqual(delta.conflicts, ['Notes/Ideas.md']);
  });

  test('Mobile receives toDelete when PC deleted a note', () => {
    const note = {
      path: 'Trash/Temp.md',
      content: 'To be removed',
      hash: NoteStore.hashContent('To be removed'),
    };
    store.upsertNotes({ notes: [note], deviceRole: 'pc' });

    // PC deletes it
    store.computeDelta({ deviceRole: 'pc', files: [] });

    // Mobile still has the file locally
    const mobileDelta = store.computeDelta({
      deviceRole: 'mobile',
      files: [note],
    });

    assert.deepEqual(mobileDelta.toDelete, ['Trash/Temp.md']);
  });
});
