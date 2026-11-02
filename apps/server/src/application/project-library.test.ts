import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalProjectRepository } from '../adapters/out/local-project-repository.js';

test('stores dated versions, restores the catalog, and keeps only the latest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lienza-projects-test-'));
  const source = join(directory, 'upload.fig');
  try {
    await writeFile(source, 'version 1');
    const store = new LocalProjectRepository(join(directory, 'library'));
    const created = await store.create('Rudo Dashboard', source, 'Rudo Dashboard.fig');
    assert.equal(created.versions[0]?.number, 1);
    assert.ok(new Date(created.versions[0]!.uploadedAt).getTime() > 0);
    await store.activate(created.id, created.versions[0]!.id);

    await writeFile(source, 'version 2');
    const updated = await store.addVersion(created.id, source, 'Rudo Dashboard new.fig');
    const latest = updated.versions.at(-1)!;
    assert.equal(latest.number, 2);
    assert.equal(await readFile(await store.versionPath(created.id, latest.id), 'utf8'), 'version 2');
    const oldPreview = `${await store.versionPath(created.id, created.versions[0]!.id)}.preview-v1.png`;
    const latestPreview = `${await store.versionPath(created.id, latest.id)}.preview-v1.png`;
    await writeFile(oldPreview, 'old preview');
    await writeFile(latestPreview, 'current preview');

    const restored = new LocalProjectRepository(join(directory, 'library'));
    const catalog = await restored.list();
    assert.deepEqual(catalog.projects[0]!.versions.map(version => version.number), [2, 1]);
    assert.equal(catalog.activeVersionId, created.versions[0]!.id);

    const pruned = await restored.prune(created.id);
    assert.deepEqual(pruned.versions.map(version => version.number), [2]);
    assert.equal((await restored.list()).activeVersionId, latest.id);
    await assert.rejects(store.versionPath(created.id, created.versions[0]!.id), /Version not found/);
    await assert.rejects(readFile(oldPreview), { code: 'ENOENT' });
    assert.equal(await readFile(latestPreview, 'utf8'), 'current preview');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('deletes a project and all its versions and previews without affecting other projects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lienza-delete-test-'));
  const source = join(directory, 'upload.fig');
  const store = new LocalProjectRepository(join(directory, 'library'));
  try {
    assert.equal(await store.hasCatalog(), false);
    await writeFile(source, 'first version');
    const removed = await store.create('Remove', source, 'Remove.fig');
    await store.activate(removed.id, removed.versions[0]!.id);
    await writeFile(source, 'second version');
    const updated = await store.addVersion(removed.id, source, 'Remove-v2.fig');
    const preview = `${await store.versionPath(removed.id, updated.versions[1]!.id)}.preview-v1.png`;
    await writeFile(preview, 'preview');
    const kept = await store.create('Keep', source, 'Keep.fig');

    await store.delete(removed.id);

    const catalog = await store.list();
    assert.equal(await store.hasCatalog(), true);
    assert.deepEqual(catalog.projects.map(project => project.id), [kept.id]);
    assert.equal(catalog.activeProjectId, null);
    assert.equal(catalog.activeVersionId, null);
    await assert.rejects(stat(join(directory, 'library', removed.id)), { code: 'ENOENT' });
    await assert.rejects(readFile(preview), { code: 'ENOENT' });
    await assert.rejects(store.versionPath(removed.id, updated.versions[0]!.id), /Project not found/);
    assert.equal(await readFile(await store.versionPath(kept.id, kept.versions[0]!.id), 'utf8'), 'second version');
    await assert.rejects(store.delete(removed.id), /Project not found/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
