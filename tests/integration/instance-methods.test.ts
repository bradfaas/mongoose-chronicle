/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { chroniclePlugin, initializeChronicle } from '../../src';

describe('Instance Methods', () => {
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
    const collections = await connection.db?.collections();
    if (collections) {
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    }
    connection.deleteModel(/.*/);
  });

  describe('getHistory()', () => {
    it('should return all chronicle chunks for a document', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        version: { type: Number, default: 1 },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('HistoryTest1', testSchema, 'history_test_1');
      await initializeChronicle(connection, 'history_test_1');

      // Create and update document multiple times
      const doc = new TestModel({ name: 'Test', version: 1 });
      await doc.save();

      doc.version = 2;
      await doc.save();

      doc.version = 3;
      await doc.save();

      // Get history
      const history = await (doc as any).getHistory();

      expect(history).toHaveLength(3);
      expect(history[0].serial).toBe(1);
      expect(history[1].serial).toBe(2);
      expect(history[2].serial).toBe(3);
    });

    it('should include chunks from all branches', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('HistoryTest2', testSchema, 'history_test_2');
      await initializeChronicle(connection, 'history_test_2');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Create a branch
      await (TestModel as any).createBranch(doc._id, 'feature-branch');

      // Update on branch
      const branchDoc = await TestModel.findById(doc._id);
      branchDoc!.name = 'Updated';
      await branchDoc!.save();

      // Get history should include chunks from both branches
      const history = await (branchDoc as any).getHistory();
      expect(history.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getBranches()', () => {
    it('should return all branches for a document', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('BranchesTest1', testSchema, 'branches_test_1');
      await initializeChronicle(connection, 'branches_test_1');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Create multiple branches
      await (TestModel as any).createBranch(doc._id, 'branch-1', { activate: false });
      await (TestModel as any).createBranch(doc._id, 'branch-2', { activate: false });

      // Get branches via instance method
      const branches = await (doc as any).getBranches();

      expect(branches).toHaveLength(3); // main + 2 branches
      expect(branches.map((b: any) => b.name)).toContain('main');
      expect(branches.map((b: any) => b.name)).toContain('branch-1');
      expect(branches.map((b: any) => b.name)).toContain('branch-2');
    });
  });

  describe('createSnapshot()', () => {
    it('should create a non-active branch as a snapshot', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        version: { type: Number, default: 1 },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SnapshotTest1', testSchema, 'snapshot_test_1');
      await initializeChronicle(connection, 'snapshot_test_1');

      const doc = new TestModel({ name: 'Test', version: 1 });
      await doc.save();

      // Create snapshot
      const snapshot = await (doc as any).createSnapshot('v1.0');

      expect(snapshot).toBeDefined();
      expect(snapshot.name).toBe('v1.0');

      // Verify we're still on main branch (snapshot doesn't activate)
      const activeBranch = await (TestModel as any).getActiveBranch(doc._id);
      expect(activeBranch.name).toBe('main');

      // Update document
      doc.version = 2;
      await doc.save();

      // Snapshot branch should still have version 1
      const snapshotChunks = await connection.db?.collection('snapshot_test_1_chronicle_chunks')
        .find({ docId: doc._id, branchId: snapshot._id })
        .toArray();

      expect(snapshotChunks).toHaveLength(1);
      expect(snapshotChunks?.[0]?.payload?.version).toBe(1);
    });
  });
});

describe('findAsOf() Static Method', () => {
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
    const collections = await connection.db?.collections();
    if (collections) {
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    }
    connection.deleteModel(/.*/);
  });

  it('should find documents matching filter at a specific point in time', async () => {
    const testSchema = new Schema({
      name: { type: String, required: true },
      category: { type: String },
      price: { type: Number },
    });
    testSchema.plugin(chroniclePlugin);

    const TestModel = connection.model('FindAsOfTest1', testSchema, 'find_asof_1');
    await initializeChronicle(connection, 'find_asof_1');

    // Create documents
    const doc1 = new TestModel({ name: 'Item1', category: 'electronics', price: 100 });
    await doc1.save();
    const time1 = new Date();

    await new Promise(resolve => setTimeout(resolve, 50));

    // Update price
    doc1.price = 150;
    await doc1.save();

    // Find at earlier time
    const results = await (TestModel as any).findAsOf({ category: 'electronics' }, time1);

    expect(results).toHaveLength(1);
    expect(results[0].price).toBe(100); // Original price
  });

  it('should return empty array when no documents match', async () => {
    const testSchema = new Schema({
      name: { type: String, required: true },
    });
    testSchema.plugin(chroniclePlugin);

    const TestModel = connection.model('FindAsOfTest2', testSchema, 'find_asof_2');
    await initializeChronicle(connection, 'find_asof_2');

    const results = await (TestModel as any).findAsOf({ name: 'NonExistent' }, new Date());
    expect(results).toEqual([]);
  });

  it('should include deleted documents in search', async () => {
    const testSchema = new Schema({
      name: { type: String, required: true },
    });
    testSchema.plugin(chroniclePlugin);

    const TestModel = connection.model('FindAsOfTest3', testSchema, 'find_asof_3');
    await initializeChronicle(connection, 'find_asof_3');

    const doc = new TestModel({ name: 'ToDelete' });
    await doc.save();
    const timeBeforeDelete = new Date();

    await new Promise(resolve => setTimeout(resolve, 50));

    // Delete the document
    await TestModel.findByIdAndDelete(doc._id);

    // Should still find it at the earlier time
    const results = await (TestModel as any).findAsOf({ name: 'ToDelete' }, timeBeforeDelete);
    expect(results).toHaveLength(1);
  });
});

describe('findOneAndUpdate Middleware', () => {
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
    const collections = await connection.db?.collections();
    if (collections) {
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    }
    connection.deleteModel(/.*/);
  });

  it('should create chronicle chunk on findOneAndUpdate', async () => {
    const testSchema = new Schema({
      name: { type: String, required: true },
      price: { type: Number },
    });
    testSchema.plugin(chroniclePlugin);

    const TestModel = connection.model('UpdateTest1', testSchema, 'update_test_1');
    await initializeChronicle(connection, 'update_test_1');

    // Create document
    const doc = new TestModel({ name: 'Product', price: 100 });
    await doc.save();

    // Update via findOneAndUpdate
    await TestModel.findOneAndUpdate(
      { _id: doc._id },
      { $set: { price: 150 } }
    );

    // Verify chunk was created
    const chunks = await connection.db?.collection('update_test_1_chronicle_chunks')
      .find({ docId: doc._id })
      .sort({ serial: 1 })
      .toArray();

    expect(chunks).toHaveLength(2);
    expect(chunks?.[1]?.payload?.price).toBe(150);
  });

  it('should create chronicle chunk on findByIdAndUpdate', async () => {
    const testSchema = new Schema({
      name: { type: String, required: true },
      quantity: { type: Number },
    });
    testSchema.plugin(chroniclePlugin);

    const TestModel = connection.model('UpdateTest2', testSchema, 'update_test_2');
    await initializeChronicle(connection, 'update_test_2');

    const doc = new TestModel({ name: 'Item', quantity: 10 });
    await doc.save();

    // Update via findByIdAndUpdate
    await TestModel.findByIdAndUpdate(doc._id, { quantity: 20 });

    // Verify chunk was created
    const chunks = await connection.db?.collection('update_test_2_chronicle_chunks')
      .find({ docId: doc._id })
      .sort({ serial: 1 })
      .toArray();

    expect(chunks).toHaveLength(2);
    expect(chunks?.[1]?.payload?.quantity).toBe(20);
  });

  it('should handle $unset operator', async () => {
    const testSchema = new Schema({
      name: { type: String, required: true },
      description: { type: String },
    });
    testSchema.plugin(chroniclePlugin);

    const TestModel = connection.model('UpdateTest3', testSchema, 'update_test_3');
    await initializeChronicle(connection, 'update_test_3');

    const doc = new TestModel({ name: 'Item', description: 'A description' });
    await doc.save();

    // Unset description
    await TestModel.findByIdAndUpdate(doc._id, { $unset: { description: '' } });

    // Verify the document was updated
    const updatedDoc = await TestModel.findById(doc._id);
    expect(updatedDoc?.description).toBeUndefined();
  });

  it('should not create chunk when document not found', async () => {
    const testSchema = new Schema({
      name: { type: String, required: true },
    });
    testSchema.plugin(chroniclePlugin);

    const TestModel = connection.model('UpdateTest4', testSchema, 'update_test_4');
    await initializeChronicle(connection, 'update_test_4');

    const fakeId = new mongoose.Types.ObjectId();

    // Try to update non-existent document
    await TestModel.findByIdAndUpdate(fakeId, { name: 'Updated' });

    // No chunks should exist
    const chunks = await connection.db?.collection('update_test_4_chronicle_chunks')
      .find({})
      .toArray();

    expect(chunks).toHaveLength(0);
  });
});
