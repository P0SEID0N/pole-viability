import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlcDataRepository } from './slc-data.repository';

describe('SlcDataRepository - missing data files', () => {
  const originalSlcDataDir = process.env.SLC_DATA_DIR;
  let emptyDir: string;

  beforeEach(() => {
    emptyDir = mkdtempSync(join(tmpdir(), 'slc-missing-'));
  });

  afterEach(() => {
    rmSync(emptyDir, { recursive: true, force: true });
    if (originalSlcDataDir === undefined) {
      delete process.env.SLC_DATA_DIR;
    } else {
      process.env.SLC_DATA_DIR = originalSlcDataDir;
    }
  });

  it('fails fast with a clear, actionable error when the data directory is empty', async () => {
    process.env.SLC_DATA_DIR = emptyDir;
    const repository = new SlcDataRepository();

    await expect(repository.onModuleInit()).rejects.toThrow(
      /SLC soil data not found.*Missing file\(s\).*ca_all_slc_v3r2\.shp/s,
    );
  });

  it('lists only the specific files that are missing, not ones that are present', async () => {
    process.env.SLC_DATA_DIR = emptyDir;
    writeFileSync(join(emptyDir, 'ca_all_slc_v3r2.shp'), '');
    writeFileSync(join(emptyDir, 'ca_all_slc_v3r2.dbf'), '');
    const repository = new SlcDataRepository();

    let error: Error | undefined;
    try {
      await repository.onModuleInit();
    } catch (e) {
      error = e as Error;
    }

    expect(error?.message).toContain('ca_all_slc_v3r2_cmp.dbf');
    expect(error?.message).not.toContain('ca_all_slc_v3r2.shp');
    expect(error?.message).not.toContain('ca_all_slc_v3r2.dbf');
  });
});
