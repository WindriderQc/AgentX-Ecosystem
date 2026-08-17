jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  realpath: jest.fn(),
  stat: jest.fn(),
  writeFile: jest.fn(),
  rename: jest.fn(),
  rm: jest.fn(),
  unlink: jest.fn()
}));

jest.mock('mammoth', () => ({
  extractRawText: jest.fn()
}));

jest.mock('pdf-parse', () => jest.fn());

const fs = require('fs/promises');

const {
  IngestWorker,
  buildTags,
  deriveSourceTag,
  describeSkip,
  needsReindex
} = require('../../src/services/ingestWorker');

describe('ingestWorker utilities', () => {
  it('derives a stable source tag and tags from the first folder beneath the configured root', () => {
    const filePath = '/data/imports/finance-docs/2026/plan.md';
    const roots = ['/data/imports', '/external/imports'];

    expect(deriveSourceTag(filePath, roots)).toBe('finance-docs');
    expect(buildTags(filePath, roots)).toEqual(['auto-ingested', 'finance-docs']);
  });

  it('marks records for reindex when mtime is newer than indexed_at', () => {
    expect(needsReindex({
      mtime: 1710000000,
      indexed_at: '2024-03-08T15:59:59.000Z'
    })).toBe(true);

    expect(needsReindex({
      mtime: 1710000000,
      indexed_at: '2024-03-09T17:00:01.000Z'
    })).toBe(false);
  });

  it('skips keys directories and oversized files', () => {
    expect(describeSkip({
      path: '/data/imports/docs/keys/private.txt',
      ext: 'txt',
      size: 128
    }, {
      roots: ['/data/imports/docs'],
      maxFileSizeBytes: 1024
    })).toEqual({ skip: true, reason: 'excluded_directory' });

    expect(describeSkip({
      path: '/data/imports/docs/big.txt',
      ext: 'txt',
      size: 4096
    }, {
      roots: ['/data/imports/docs'],
      maxFileSizeBytes: 1024
    })).toEqual({ skip: true, reason: 'oversized' });
  });

  it('excludes secret names, generated exports, and private roots deterministically', () => {
    expect(describeSkip({
      path: '/data/imports/docs/.env', ext: '', size: 10
    }, { roots: ['/data/imports/docs'] })).toEqual({ skip: true, reason: 'secret_material' });

    expect(describeSkip({
      path: '/data/imports/docs/generated_export.md', ext: 'md', size: 10
    }, { roots: ['/data/imports/docs'] })).toEqual({ skip: true, reason: 'generated_export' });

    expect(describeSkip({
      path: '/private/imports/accounts.md', ext: 'md', size: 10
    }, { roots: ['/private/imports'] })).toEqual({ skip: true, reason: 'outside_source' });
  });
});

function mockCursor(records) {
  let index = 0;
  const cursor = {
    sort: jest.fn().mockReturnThis(),
    close: jest.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (index < records.length) {
            return Promise.resolve({ value: records[index++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        }
      };
    }
  };
  return cursor;
}

describe('IngestWorker', () => {
  let collection;
  let db;

  beforeEach(() => {
    jest.clearAllMocks();
    fs.realpath.mockImplementation(async (value) => value);
    fs.stat.mockResolvedValue({ isDirectory: () => true, isFile: () => true });

    collection = {
      find: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 })
    };

    db = {
      collection: jest.fn().mockReturnValue(collection)
    };
  });

  it('ingests new files and updates indexed_at metadata in nas_files', async () => {
    const record = {
      _id: 'doc-1',
      path: '/data/imports/docs/report.md',
      ext: 'md',
      size: 512,
      mtime: 1710000000
    };

    collection.find.mockReturnValue(mockCursor([record]));
    fs.readFile.mockResolvedValue('# Quarterly update');

    const ingestDocument = jest.fn().mockResolvedValue({
      documentId: record.path,
      chunkCount: 2,
      status: 'created'
    });

    const worker = new IngestWorker({
      db,
      roots: ['/data/imports/docs'],
      ingestDocument,
      batchDelayMs: 0
    });

    const summary = await worker.run();

    expect(summary.totalCandidates).toBe(1);
    expect(summary.ingested).toBe(1);
    expect(summary.failed).toBe(0);
    expect(ingestDocument).toHaveBeenCalledWith(expect.objectContaining({
      text: '# Quarterly update',
      source: 'docs',
      tags: ['auto-ingested', 'docs'],
      documentId: record.path
    }));
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'doc-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          indexed_status: 'ingested',
          indexed_document_id: record.path,
          indexed_source: 'docs',
          indexed_tags: ['auto-ingested', 'docs'],
          indexed_error: null
        })
      })
    );
  });

  it('re-ingests changed files and reports them as updated', async () => {
    const record = {
      _id: 'doc-2',
      path: '/data/imports/docs/guide.txt',
      ext: 'txt',
      size: 64,
      mtime: 1710001000,
      indexed_at: '2024-03-09T15:00:00.000Z'
    };

    collection.find.mockReturnValue(mockCursor([record]));
    fs.readFile.mockResolvedValue('Updated guide content');

    const worker = new IngestWorker({
      db,
      roots: ['/data/imports/docs'],
      ingestDocument: jest.fn().mockResolvedValue({
        documentId: record.path,
        chunkCount: 1,
        status: 'created'
      }),
      batchDelayMs: 0
    });

    const summary = await worker.run();

    expect(summary.updated).toBe(1);
    expect(summary.ingested).toBe(0);
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'doc-2' },
      expect.objectContaining({
        $set: expect.objectContaining({
          indexed_status: 'updated'
        })
      })
    );
  });

  it('records extraction errors and continues instead of throwing', async () => {
    const record = {
      _id: 'doc-3',
      path: '/data/imports/docs/broken.txt',
      ext: 'txt',
      size: 32,
      mtime: 1710002000
    };

    fs.readFile.mockRejectedValue(new Error('ENOENT'));

    const worker = new IngestWorker({
      db,
      roots: ['/data/imports/docs'],
      ingestDocument: jest.fn(),
      batchDelayMs: 0
    });

    const result = await worker.processRecord(record);

    expect(result).toEqual(expect.objectContaining({
      status: 'failed',
      reason: 'ENOENT',
      path: record.path,
      source: 'docs'
    }));
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'doc-3' },
      expect.objectContaining({
        $set: expect.objectContaining({
          indexed_error: 'ENOENT',
          indexed_document_id: record.path
        })
      })
    );
  });

  it('rejects symlink traversal before reading file content', async () => {
    const record = {
      _id: 'doc-symlink',
      path: '/data/imports/docs/linked-note.md',
      ext: 'md',
      size: 64,
      mtime: 1710003000
    };
    fs.realpath.mockImplementation(async (value) => (
      value === record.path ? '/etc/linked-secret.md' : value
    ));

    const worker = new IngestWorker({
      db,
      roots: ['/data/imports/docs'],
      ingestDocument: jest.fn(),
      batchDelayMs: 0
    });
    const result = await worker.processRecord(record);

    expect(result).toMatchObject({ status: 'failed', reason: expect.stringMatching(/Symlink traversal/) });
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('fails closed before querying Mongo when the approved root is absent', async () => {
    fs.realpath.mockRejectedValueOnce(new Error('ENOENT'));
    const worker = new IngestWorker({
      db,
      roots: ['/data/imports/docs'],
      ingestDocument: jest.fn(),
      batchDelayMs: 0
    });

    await expect(worker.run()).rejects.toMatchObject({ code: 'INGEST_ROOT_UNAVAILABLE' });
    expect(collection.find).not.toHaveBeenCalled();
  });

  it('does not mutate imported files while ingesting', async () => {
    const record = {
      _id: 'doc-read-only',
      path: '/data/imports/docs/read-only.md',
      ext: 'md',
      size: 64,
      mtime: 1710004000
    };
    collection.find.mockReturnValue(mockCursor([record]));
    fs.readFile.mockResolvedValue('Read-only corpus');
    const worker = new IngestWorker({
      db,
      roots: ['/data/imports/docs'],
      ingestDocument: jest.fn().mockResolvedValue({ chunkCount: 1 }),
      batchDelayMs: 0
    });

    await worker.run();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
  });
});
