import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { chroniclePlugin, initializeChronicle } from '../../src';

describe('History Management Operations', () => {
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

  describe('chronicleRevert', () => {
    it('should revert to a specific serial and remove newer chunks', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        counter: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('RevertTest1', testSchema, 'revert_test_1');
      await initializeChronicle(connection, 'revert_test_1');

      // Create document and make several updates
      const doc = new TestModel({ name: 'Test', counter: 1 });
      await doc.save(); // serial 1

      doc.counter = 2;
      await doc.save(); // serial 2

      doc.counter = 3;
      await doc.save(); // serial 3

      doc.counter = 4;
      await doc.save(); // serial 4

      // Verify we have 4 chunks
      let chunks = await connection.db?.collection('revert_test_1_chronicle_chunks')
        .find({ docId: doc._id })
        .toArray();
      expect(chunks).toHaveLength(4);

      // Revert to serial 2
      const result = await (TestModel as any).chronicleRevert(doc._id, 2);

      expect(result.success).toBe(true);
      expect(result.revertedToSerial).toBe(2);
      expect(result.chunksRemoved).toBe(2); // Removed serials 3 and 4
      expect(result.state).toMatchObject({ name: 'Test', counter: 2 });

      // Verify only 2 chunks remain
      chunks = await connection.db?.collection('revert_test_1_chronicle_chunks')
        .find({ docId: doc._id })
        .toArray();
      expect(chunks).toHaveLength(2);

      // Verify serial 2 is now marked as latest
      const latestChunk = await connection.db?.collection('revert_test_1_chronicle_chunks')
        .findOne({ docId: doc._id, isLatest: true });
      expect(latestChunk?.serial).toBe(2);
    });

    it('should be a no-op when target is already latest', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        counter: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('RevertTest2', testSchema, 'revert_test_2');
      await initializeChronicle(connection, 'revert_test_2');

      const doc = new TestModel({ name: 'Test', counter: 1 });
      await doc.save(); // serial 1

      doc.counter = 2;
      await doc.save(); // serial 2

      // Revert to the current latest (serial 2)
      const result = await (TestModel as any).chronicleRevert(doc._id, 2);

      expect(result.success).toBe(true);
      expect(result.revertedToSerial).toBe(2);
      expect(result.chunksRemoved).toBe(0);
      expect(result.branchesUpdated).toBe(0);
    });

    it('should throw error for non-existent serial', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('RevertTest3', testSchema, 'revert_test_3');
      await initializeChronicle(connection, 'revert_test_3');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      await expect((TestModel as any).chronicleRevert(doc._id, 999))
        .rejects.toThrow(/Serial 999 not found/);
    });

    it('should revert on a specific branch', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('RevertTest4', testSchema, 'revert_test_4');
      await initializeChronicle(connection, 'revert_test_4');

      // Create document
      const doc = new TestModel({ name: 'Test', value: 1 });
      await doc.save(); // main serial 1

      // Create a branch (auto-activates)
      const branch = await (TestModel as any).createBranch(doc._id, 'feature');

      // Make updates on the branch
      doc.value = 100;
      await doc.save(); // feature serial 2

      doc.value = 200;
      await doc.save(); // feature serial 3

      // Revert the feature branch to serial 1
      const result = await (TestModel as any).chronicleRevert(doc._id, 1, {
        branchId: branch._id,
      });

      expect(result.success).toBe(true);
      expect(result.chunksRemoved).toBe(2);

      // Main branch should still be intact
      const mainBranch = await connection.db?.collection('revert_test_4_chronicle_branches')
        .findOne({ docId: doc._id, name: 'main' });
      const mainChunks = await connection.db?.collection('revert_test_4_chronicle_chunks')
        .find({ branchId: mainBranch?._id })
        .toArray();
      expect(mainChunks).toHaveLength(1);
    });

    it('should update orphaned branch parentSerial when reverting past branch point', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        counter: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('RevertTest5', testSchema, 'revert_test_5');
      await initializeChronicle(connection, 'revert_test_5');

      // Create document and make several updates
      const doc = new TestModel({ name: 'Test', counter: 1 });
      await doc.save(); // serial 1

      doc.counter = 2;
      await doc.save(); // serial 2

      doc.counter = 3;
      await doc.save(); // serial 3

      // Create a branch from serial 3 without activating
      const childBranch = await (TestModel as any).createBranch(doc._id, 'child', {
        activate: false,
        fromSerial: 3,
      });

      expect(childBranch.parentSerial).toBe(3);

      // Continue on main
      doc.counter = 4;
      await doc.save(); // serial 4

      // Revert main to serial 2 (past the branch point at 3)
      const result = await (TestModel as any).chronicleRevert(doc._id, 2);

      expect(result.success).toBe(true);
      expect(result.branchesUpdated).toBe(1);

      // Child branch should now have parentSerial = 2
      const updatedChildBranch = await connection.db?.collection('revert_test_5_chronicle_branches')
        .findOne({ _id: childBranch._id });
      expect(updatedChildBranch?.parentSerial).toBe(2);
    });

    it('should skip rehydration when rehydrate: false', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        counter: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('RevertTest6', testSchema, 'revert_test_6');
      await initializeChronicle(connection, 'revert_test_6');

      const doc = new TestModel({ name: 'Test', counter: 1 });
      await doc.save();

      doc.counter = 2;
      await doc.save();

      const result = await (TestModel as any).chronicleRevert(doc._id, 1, {
        rehydrate: false,
      });

      expect(result.success).toBe(true);
      expect(result.state).toBeUndefined();
    });
  });

  describe('chronicleSquash', () => {
    it('should squash all history to a single FULL chunk', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        counter: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SquashTest1', testSchema, 'squash_test_1');
      await initializeChronicle(connection, 'squash_test_1');

      // Create document and make several updates
      const doc = new TestModel({ name: 'Test', counter: 1 });
      await doc.save(); // serial 1

      doc.counter = 2;
      await doc.save(); // serial 2

      doc.counter = 3;
      await doc.save(); // serial 3

      // Create a branch
      await (TestModel as any).createBranch(doc._id, 'feature', { activate: false });

      // Verify we have multiple chunks and branches
      let chunks = await connection.db?.collection('squash_test_1_chronicle_chunks')
        .find({ docId: doc._id }).toArray();
      let branches = await connection.db?.collection('squash_test_1_chronicle_branches')
        .find({ docId: doc._id }).toArray();
      expect(chunks?.length).toBeGreaterThan(1);
      expect(branches?.length).toBe(2); // main + feature

      // Squash to serial 3
      const result = await (TestModel as any).chronicleSquash(doc._id, 3, { confirm: true });

      expect(result.success).toBe(true);
      expect(result.previousChunkCount).toBeGreaterThan(1);
      expect(result.previousBranchCount).toBe(2);
      expect(result.newState).toMatchObject({ name: 'Test', counter: 3 });

      // Verify only 1 chunk remains
      chunks = await connection.db?.collection('squash_test_1_chronicle_chunks')
        .find({ docId: doc._id }).toArray();
      expect(chunks).toHaveLength(1);
      expect(chunks?.[0]?.serial).toBe(1);
      expect(chunks?.[0]?.ccType).toBe(1); // FULL
      expect(chunks?.[0]?.isLatest).toBe(true);

      // Verify only 1 branch (main) remains
      branches = await connection.db?.collection('squash_test_1_chronicle_branches')
        .find({ docId: doc._id }).toArray();
      expect(branches).toHaveLength(1);
      expect(branches?.[0]?.name).toBe('main');
      expect(branches?.[0]?.parentBranchId).toBeNull();
    });

    it('should require confirm: true', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SquashTest2', testSchema, 'squash_test_2');
      await initializeChronicle(connection, 'squash_test_2');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Should throw without confirm
      await expect((TestModel as any).chronicleSquash(doc._id, 1, { confirm: false }))
        .rejects.toThrow(/Squash requires explicit confirmation/);
    });

    it('should support dry run preview', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        counter: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SquashTest3', testSchema, 'squash_test_3');
      await initializeChronicle(connection, 'squash_test_3');

      // Create document and make several updates
      const doc = new TestModel({ name: 'Test', counter: 1 });
      await doc.save();

      doc.counter = 2;
      await doc.save();

      doc.counter = 3;
      await doc.save();

      // Create a branch
      await (TestModel as any).createBranch(doc._id, 'feature', { activate: false });

      // Get counts before dry run
      const chunksBefore = await connection.db?.collection('squash_test_3_chronicle_chunks')
        .find({ docId: doc._id }).toArray();
      const branchesBefore = await connection.db?.collection('squash_test_3_chronicle_branches')
        .find({ docId: doc._id }).toArray();

      // Dry run
      const preview = await (TestModel as any).chronicleSquash(doc._id, 3, {
        confirm: false,
        dryRun: true,
      });

      expect(preview.wouldDelete).toBeDefined();
      expect(preview.wouldDelete.chunks).toBe(chunksBefore?.length);
      expect(preview.wouldDelete.branches).toBe((branchesBefore?.length ?? 0) - 1); // All except new main
      expect(preview.newBaseState).toMatchObject({ name: 'Test', counter: 3 });

      // Verify nothing was actually deleted
      const chunksAfter = await connection.db?.collection('squash_test_3_chronicle_chunks')
        .find({ docId: doc._id }).toArray();
      const branchesAfter = await connection.db?.collection('squash_test_3_chronicle_branches')
        .find({ docId: doc._id }).toArray();

      expect(chunksAfter?.length).toBe(chunksBefore?.length);
      expect(branchesAfter?.length).toBe(branchesBefore?.length);
    });

    it('should squash to a state from a specific branch', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SquashTest4', testSchema, 'squash_test_4');
      await initializeChronicle(connection, 'squash_test_4');

      // Create document
      const doc = new TestModel({ name: 'Test', value: 1 });
      await doc.save(); // main serial 1

      // Create and switch to a feature branch
      const featureBranch = await (TestModel as any).createBranch(doc._id, 'feature');

      // Make changes on feature branch
      doc.value = 100;
      await doc.save(); // feature serial 2

      doc.value = 200;
      await doc.save(); // feature serial 3

      // Squash to feature branch serial 2 (value = 100)
      const result = await (TestModel as any).chronicleSquash(doc._id, 2, {
        branchId: featureBranch._id,
        confirm: true,
      });

      expect(result.success).toBe(true);
      expect(result.newState).toMatchObject({ name: 'Test', value: 100 });

      // Verify final state
      const chunks = await connection.db?.collection('squash_test_4_chronicle_chunks')
        .find({ docId: doc._id }).toArray();
      expect(chunks).toHaveLength(1);
      expect(chunks?.[0]?.payload).toMatchObject({ name: 'Test', value: 100 });
    });

    it('should throw error for non-existent serial', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SquashTest5', testSchema, 'squash_test_5');
      await initializeChronicle(connection, 'squash_test_5');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      await expect((TestModel as any).chronicleSquash(doc._id, 999, { confirm: true }))
        .rejects.toThrow(/Serial 999 not found/);
    });

    it('should update metadata to point to new main branch', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SquashTest6', testSchema, 'squash_test_6');
      await initializeChronicle(connection, 'squash_test_6');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Create a branch and switch to it
      await (TestModel as any).createBranch(doc._id, 'feature');

      // Squash
      await (TestModel as any).chronicleSquash(doc._id, 1, { confirm: true });

      // Verify metadata points to the new main branch
      const metadata = await connection.db?.collection('squash_test_6_chronicle_metadata')
        .findOne({ docId: doc._id });
      const branches = await connection.db?.collection('squash_test_6_chronicle_branches')
        .find({ docId: doc._id }).toArray();

      expect(branches).toHaveLength(1);
      expect(metadata?.activeBranchId.toString()).toBe(branches?.[0]?._id.toString());
      expect(branches?.[0]?.name).toBe('main');
    });
  });
});
