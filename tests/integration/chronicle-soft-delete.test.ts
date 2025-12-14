import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { chroniclePlugin, initializeChronicle } from '../../src';

describe('Chronicle Soft Delete', () => {
  let mongoServer: MongoMemoryServer;
  let connection: mongoose.Connection;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    connection = mongoose.createConnection(uri);
    await connection.asPromise();
  });

  afterAll(async () => {
    await connection.close();
    await mongoServer.stop();
  });

  afterEach(async () => {
    // Clean up all collections
    const collections = await connection.db?.collections();
    if (collections) {
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    }
  });

  describe('chronicleSoftDelete', () => {
    it('should create a deletion chunk with isDeleted: true', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        price: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SoftDeleteTest1', testSchema, 'soft_delete_test_1');
      await initializeChronicle(connection, 'soft_delete_test_1');

      // Create document
      const doc = new TestModel({ name: 'Product', price: 100 });
      await doc.save();

      // Soft delete
      const result = await (TestModel as any).chronicleSoftDelete(doc._id);

      expect(result.chunkId).toBeDefined();
      expect(result.finalState).toMatchObject({ name: 'Product', price: 100 });

      // Verify deletion chunk exists
      const chunks = await connection.db?.collection('soft_delete_test_1_chronicle_chunks')
        .find({ docId: doc._id })
        .sort({ serial: 1 })
        .toArray();

      expect(chunks).toHaveLength(2);
      expect(chunks?.[1]?.isDeleted).toBe(true);
      expect(chunks?.[1]?.isLatest).toBe(true);
    });

    it('should throw error when soft deleting already deleted document', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SoftDeleteTest2', testSchema, 'soft_delete_test_2');
      await initializeChronicle(connection, 'soft_delete_test_2');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // First soft delete should succeed
      await (TestModel as any).chronicleSoftDelete(doc._id);

      // Second soft delete should throw
      await expect(
        (TestModel as any).chronicleSoftDelete(doc._id)
      ).rejects.toThrow(/already deleted/);
    });

    it('should release unique constraints on soft delete', async () => {
      const testSchema = new Schema({
        email: { type: String, required: true },
        name: { type: String },
      });
      testSchema.plugin(chroniclePlugin, {
        uniqueKeys: ['email'],
      });

      const TestModel = connection.model('SoftDeleteTest3', testSchema, 'soft_delete_test_3');
      await initializeChronicle(connection, 'soft_delete_test_3', {
        uniqueKeys: ['email'],
      });

      // Create first document
      const doc1 = new TestModel({ email: 'test@example.com', name: 'First' });
      await doc1.save();

      // Soft delete first document
      await (TestModel as any).chronicleSoftDelete(doc1._id);

      // Check that the keys entry is marked as deleted
      const keysEntry = await connection.db?.collection('soft_delete_test_3_chronicle_keys')
        .findOne({ docId: doc1._id });
      expect(keysEntry?.isDeleted).toBe(true);

      // Creating new document with same email should succeed (unique constraint released)
      const doc2 = new TestModel({ email: 'test@example.com', name: 'Second' });
      await expect(doc2.save()).resolves.toBeDefined();
    });
  });

  describe('Query Filtering via Chunks Collection', () => {
    it('should mark deleted documents with isDeleted flag in chunks', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        category: { type: String },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('QueryFilterTest1', testSchema, 'query_filter_test_1');
      await initializeChronicle(connection, 'query_filter_test_1');

      // Create documents
      const doc1 = new TestModel({ name: 'Active1', category: 'A' });
      const doc2 = new TestModel({ name: 'Active2', category: 'A' });
      const doc3 = new TestModel({ name: 'ToDelete', category: 'A' });
      await doc1.save();
      await doc2.save();
      await doc3.save();

      // Soft delete one
      await (TestModel as any).chronicleSoftDelete(doc3._id);

      // Query chunks directly - active documents should have isDeleted: false
      const activeChunks = await connection.db?.collection('query_filter_test_1_chronicle_chunks')
        .find({ isLatest: true, isDeleted: false })
        .toArray();
      expect(activeChunks).toHaveLength(2);

      // Deleted chunk should have isDeleted: true
      const deletedChunk = await connection.db?.collection('query_filter_test_1_chronicle_chunks')
        .findOne({ docId: doc3._id, isLatest: true });
      expect(deletedChunk?.isDeleted).toBe(true);
    });

    it('should allow querying deleted documents via chronicleListDeleted', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('QueryFilterTest2', testSchema, 'query_filter_test_2');
      await initializeChronicle(connection, 'query_filter_test_2');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      await (TestModel as any).chronicleSoftDelete(doc._id);

      // Should find via chronicleListDeleted
      const deleted = await (TestModel as any).chronicleListDeleted();
      expect(deleted).toHaveLength(1);
      expect(deleted[0].finalState.name).toBe('Test');
    });

    it('should support querying non-deleted documents via chunk collection', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('QueryFilterTest3', testSchema, 'query_filter_test_3');
      await initializeChronicle(connection, 'query_filter_test_3');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      await (TestModel as any).chronicleSoftDelete(doc._id);

      // Query for non-deleted should return nothing
      const activeCount = await connection.db?.collection('query_filter_test_3_chronicle_chunks')
        .countDocuments({ isLatest: true, isDeleted: false });
      expect(activeCount).toBe(0);
    });

    it('should track deleted documents count accurately', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('QueryFilterTest4', testSchema, 'query_filter_test_4');
      await initializeChronicle(connection, 'query_filter_test_4');

      const doc1 = new TestModel({ name: 'Active' });
      const doc2 = new TestModel({ name: 'ToDelete' });
      await doc1.save();
      await doc2.save();

      await (TestModel as any).chronicleSoftDelete(doc2._id);

      // Count active documents in chunks
      const activeCount = await connection.db?.collection('query_filter_test_4_chronicle_chunks')
        .countDocuments({ isLatest: true, isDeleted: false });
      expect(activeCount).toBe(1);

      // Count deleted documents
      const deletedCount = await connection.db?.collection('query_filter_test_4_chronicle_chunks')
        .countDocuments({ isLatest: true, isDeleted: true });
      expect(deletedCount).toBe(1);
    });
  });

  describe('chronicleUndelete', () => {
    it('should restore a soft-deleted document', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('UndeleteTest1', testSchema, 'undelete_test_1');
      await initializeChronicle(connection, 'undelete_test_1');

      const doc = new TestModel({ name: 'Test', value: 42 });
      await doc.save();

      await (TestModel as any).chronicleSoftDelete(doc._id);

      // Verify deleted in chunks
      const deletedChunk = await connection.db?.collection('undelete_test_1_chronicle_chunks')
        .findOne({ docId: doc._id, isLatest: true });
      expect(deletedChunk?.isDeleted).toBe(true);

      // Restore
      const result = await (TestModel as any).chronicleUndelete(doc._id);

      expect(result.success).toBe(true);
      expect(result.restoredState).toMatchObject({ name: 'Test', value: 42 });

      // Verify restored in chunks (latest chunk should have isDeleted: false)
      const restoredChunk = await connection.db?.collection('undelete_test_1_chronicle_chunks')
        .findOne({ docId: doc._id, isLatest: true });
      expect(restoredChunk?.isDeleted).toBe(false);
    });

    it('should throw error when undeleting a non-deleted document', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('UndeleteTest2', testSchema, 'undelete_test_2');
      await initializeChronicle(connection, 'undelete_test_2');

      const doc = new TestModel({ name: 'Active' });
      await doc.save();

      await expect(
        (TestModel as any).chronicleUndelete(doc._id)
      ).rejects.toThrow(/not deleted/);
    });

    it('should restore document state correctly after undelete', async () => {
      const testSchema = new Schema({
        email: { type: String, required: true },
        name: { type: String },
      });
      testSchema.plugin(chroniclePlugin, {
        uniqueKeys: ['email'],
      });

      const TestModel = connection.model('UndeleteTest3', testSchema, 'undelete_test_3');
      await initializeChronicle(connection, 'undelete_test_3', {
        uniqueKeys: ['email'],
      });

      // Create and update doc multiple times
      const doc = new TestModel({ email: 'test@example.com', name: 'Original' });
      await doc.save();
      doc.name = 'Updated';
      await doc.save();

      // Soft delete
      await (TestModel as any).chronicleSoftDelete(doc._id);

      // Verify keys marked as deleted
      const keysBeforeUndelete = await connection.db?.collection('undelete_test_3_chronicle_keys')
        .findOne({ docId: doc._id });
      expect(keysBeforeUndelete?.isDeleted).toBe(true);

      // Undelete
      const result = await (TestModel as any).chronicleUndelete(doc._id);
      expect(result.success).toBe(true);
      expect(result.restoredState.name).toBe('Updated'); // Should restore final state

      // Verify keys marked as not deleted
      const keysAfterUndelete = await connection.db?.collection('undelete_test_3_chronicle_keys')
        .findOne({ docId: doc._id });
      expect(keysAfterUndelete?.isDeleted).toBe(false);
    });
  });

  describe('chronicleListDeleted', () => {
    it('should list all deleted documents', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('ListDeletedTest1', testSchema, 'list_deleted_test_1');
      await initializeChronicle(connection, 'list_deleted_test_1');

      const doc1 = new TestModel({ name: 'Doc1' });
      const doc2 = new TestModel({ name: 'Doc2' });
      const doc3 = new TestModel({ name: 'Doc3' });
      await doc1.save();
      await doc2.save();
      await doc3.save();

      // Delete two documents
      await (TestModel as any).chronicleSoftDelete(doc1._id);
      await (TestModel as any).chronicleSoftDelete(doc2._id);

      const deleted = await (TestModel as any).chronicleListDeleted();

      expect(deleted).toHaveLength(2);
      expect(deleted.map((d: any) => d.finalState.name)).toContain('Doc1');
      expect(deleted.map((d: any) => d.finalState.name)).toContain('Doc2');
      expect(deleted.map((d: any) => d.finalState.name)).not.toContain('Doc3');
    });

    it('should filter by deletion time range', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('ListDeletedTest2', testSchema, 'list_deleted_test_2');
      await initializeChronicle(connection, 'list_deleted_test_2');

      const doc1 = new TestModel({ name: 'Early' });
      await doc1.save();
      await (TestModel as any).chronicleSoftDelete(doc1._id);

      // Get the timestamp of the first deletion
      const earlyChunk = await connection.db?.collection('list_deleted_test_2_chronicle_chunks')
        .findOne({ docId: doc1._id, isLatest: true });
      const earlyTime = earlyChunk?.cTime as Date;

      // Delay to ensure distinct timestamps
      await new Promise(resolve => setTimeout(resolve, 100));

      const doc2 = new TestModel({ name: 'Late' });
      await doc2.save();
      await (TestModel as any).chronicleSoftDelete(doc2._id);

      // Get the timestamp of the second deletion
      const lateChunk = await connection.db?.collection('list_deleted_test_2_chronicle_chunks')
        .findOne({ docId: doc2._id, isLatest: true });
      const lateTime = lateChunk?.cTime as Date;

      // Filter for early deletions only (before the late deletion)
      const earlyDeleted = await (TestModel as any).chronicleListDeleted({
        deletedBefore: lateTime,
      });
      expect(earlyDeleted).toHaveLength(1);
      expect(earlyDeleted[0].finalState.name).toBe('Early');

      // Filter for late deletions only (after the early deletion)
      const lateDeleted = await (TestModel as any).chronicleListDeleted({
        deletedAfter: earlyTime,
      });
      expect(lateDeleted).toHaveLength(1);
      expect(lateDeleted[0].finalState.name).toBe('Late');
    });
  });

  describe('chroniclePurge', () => {
    it('should permanently remove all chronicle data with confirm', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('PurgeTest1', testSchema, 'purge_test_1');
      await initializeChronicle(connection, 'purge_test_1');

      const doc = new TestModel({ name: 'ToDelete' });
      await doc.save();

      // Make some updates to create history
      doc.name = 'Updated1';
      await doc.save();
      doc.name = 'Updated2';
      await doc.save();

      // Soft delete
      await (TestModel as any).chronicleSoftDelete(doc._id);

      // Purge
      const result = await (TestModel as any).chroniclePurge(doc._id, { confirm: true });

      expect(result.success).toBe(true);
      expect(result.chunksRemoved).toBeGreaterThan(0);
      expect(result.branchesRemoved).toBe(1);

      // Verify nothing remains
      const chunks = await connection.db?.collection('purge_test_1_chronicle_chunks')
        .find({ docId: doc._id })
        .toArray();
      expect(chunks).toHaveLength(0);

      const metadata = await connection.db?.collection('purge_test_1_chronicle_metadata')
        .find({ docId: doc._id })
        .toArray();
      expect(metadata).toHaveLength(0);
    });

    it('should throw error without confirm flag', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('PurgeTest2', testSchema, 'purge_test_2');
      await initializeChronicle(connection, 'purge_test_2');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      await expect(
        (TestModel as any).chroniclePurge(doc._id, { confirm: false })
      ).rejects.toThrow(/requires explicit confirmation/);
    });
  });

  describe('Direct Soft Delete API', () => {
    it('should soft delete via chronicleSoftDelete static method', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('MiddlewareTest1', testSchema, 'middleware_test_1');
      await initializeChronicle(connection, 'middleware_test_1');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Use chronicleSoftDelete directly
      const result = await (TestModel as any).chronicleSoftDelete(doc._id);

      expect(result.chunkId).toBeDefined();
      expect(result.finalState).toMatchObject({ name: 'Test' });

      // Document should be soft deleted
      const chunks = await connection.db?.collection('middleware_test_1_chronicle_chunks')
        .find({ docId: doc._id })
        .toArray();

      expect(chunks?.length).toBeGreaterThan(0);
      expect(chunks?.find(c => c.isLatest)?.isDeleted).toBe(true);
    });

    it('should preserve chronicle history after soft delete', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        counter: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('MiddlewareTest2', testSchema, 'middleware_test_2');
      await initializeChronicle(connection, 'middleware_test_2');

      const doc = new TestModel({ name: 'Test', counter: 1 });
      await doc.save();

      // Make some updates
      doc.counter = 2;
      await doc.save();
      doc.counter = 3;
      await doc.save();

      // Soft delete
      await (TestModel as any).chronicleSoftDelete(doc._id);

      // All chunks should still exist (history preserved)
      const chunks = await connection.db?.collection('middleware_test_2_chronicle_chunks')
        .find({ docId: doc._id })
        .sort({ serial: 1 })
        .toArray();

      expect(chunks?.length).toBe(4); // 3 saves + 1 delete chunk
      expect(chunks?.[chunks.length - 1]?.isDeleted).toBe(true);
    });

    it('should soft delete multiple documents individually', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        category: { type: String },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('MiddlewareTest3', testSchema, 'middleware_test_3');
      await initializeChronicle(connection, 'middleware_test_3');

      const doc1 = new TestModel({ name: 'Test1', category: 'A' });
      const doc2 = new TestModel({ name: 'Test2', category: 'A' });
      const doc3 = new TestModel({ name: 'Test3', category: 'B' });
      await doc1.save();
      await doc2.save();
      await doc3.save();

      // Soft delete category A documents individually
      await (TestModel as any).chronicleSoftDelete(doc1._id);
      await (TestModel as any).chronicleSoftDelete(doc2._id);

      // Category A docs should be soft deleted
      const chunk1 = await connection.db?.collection('middleware_test_3_chronicle_chunks')
        .findOne({ docId: doc1._id, isLatest: true });
      const chunk2 = await connection.db?.collection('middleware_test_3_chronicle_chunks')
        .findOne({ docId: doc2._id, isLatest: true });
      const chunk3 = await connection.db?.collection('middleware_test_3_chronicle_chunks')
        .findOne({ docId: doc3._id, isLatest: true });

      expect(chunk1?.isDeleted).toBe(true);
      expect(chunk2?.isDeleted).toBe(true);
      expect(chunk3?.isDeleted).toBe(false);
    });
  });

  describe('Epoch Tracking', () => {
    it('should include epoch in chunks', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('EpochTest1', testSchema, 'epoch_test_1');
      await initializeChronicle(connection, 'epoch_test_1');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      const chunk = await connection.db?.collection('epoch_test_1_chronicle_chunks')
        .findOne({ docId: doc._id });

      expect(chunk?.epoch).toBe(1);
    });

    it('should include epoch in branches', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('EpochTest2', testSchema, 'epoch_test_2');
      await initializeChronicle(connection, 'epoch_test_2');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      const branch = await connection.db?.collection('epoch_test_2_chronicle_branches')
        .findOne({ docId: doc._id });

      expect(branch?.epoch).toBe(1);
    });

    it('should include epoch in metadata', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('EpochTest3', testSchema, 'epoch_test_3');
      await initializeChronicle(connection, 'epoch_test_3');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      const metadata = await connection.db?.collection('epoch_test_3_chronicle_metadata')
        .findOne({ docId: doc._id });

      expect(metadata?.epoch).toBe(1);
    });
  });
});
