import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { chroniclePlugin, initializeChronicle } from '../../src';

describe('chronicleAsOf - Point-in-Time Rehydration', () => {
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

  /**
   * Helper to create a small delay between saves to ensure distinct timestamps
   */
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  describe('Basic Single Branch Queries', () => {
    it('should return document state at a specific timestamp', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        price: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('AsOfTest1', testSchema, 'asof_test_1');
      await initializeChronicle(connection, 'asof_test_1');

      // Create document
      const doc = new TestModel({ name: 'Product', price: 100 });
      await doc.save();
      const timeAfterCreate = new Date();

      await delay(50);

      // Update document
      doc.price = 150;
      await doc.save();
      const timeAfterUpdate1 = new Date();

      await delay(50);

      // Another update
      doc.price = 200;
      await doc.save();

      // Query at different points in time
      const stateAtCreate = await (TestModel as any).chronicleAsOf(doc._id, timeAfterCreate);
      expect(stateAtCreate.found).toBe(true);
      expect(stateAtCreate.state).toMatchObject({ name: 'Product', price: 100 });

      const stateAtUpdate1 = await (TestModel as any).chronicleAsOf(doc._id, timeAfterUpdate1);
      expect(stateAtUpdate1.found).toBe(true);
      expect(stateAtUpdate1.state).toMatchObject({ name: 'Product', price: 150 });
    });

    it('should return found: false when document did not exist at timestamp', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('AsOfTest2', testSchema, 'asof_test_2');
      await initializeChronicle(connection, 'asof_test_2');

      const timeBeforeCreate = new Date();

      await delay(50);

      // Create document after the timestamp
      const doc = new TestModel({ name: 'LateProduct' });
      await doc.save();

      // Query at time before creation
      const result = await (TestModel as any).chronicleAsOf(doc._id, timeBeforeCreate);
      expect(result.found).toBe(false);
    });

    it('should return current state when asOf is in the future', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        counter: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('AsOfTest3', testSchema, 'asof_test_3');
      await initializeChronicle(connection, 'asof_test_3');

      const doc = new TestModel({ name: 'Test', counter: 1 });
      await doc.save();

      doc.counter = 5;
      await doc.save();

      // Query with future timestamp
      const futureDate = new Date(Date.now() + 86400000); // Tomorrow
      const result = await (TestModel as any).chronicleAsOf(doc._id, futureDate);

      expect(result.found).toBe(true);
      expect(result.state).toMatchObject({ name: 'Test', counter: 5 });
    });

    it('should include chunk exactly at the asOf timestamp', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('AsOfTest4', testSchema, 'asof_test_4');
      await initializeChronicle(connection, 'asof_test_4');

      const doc = new TestModel({ name: 'Test', value: 10 });
      await doc.save();

      // Get the chunk timestamp
      const chunk = await connection.db?.collection('asof_test_4_chronicle_chunks')
        .findOne({ docId: doc._id });
      const exactTimestamp = chunk?.cTime as Date;

      // Query at exact chunk timestamp
      const result = await (TestModel as any).chronicleAsOf(doc._id, exactTimestamp);

      expect(result.found).toBe(true);
      expect(result.state).toMatchObject({ name: 'Test', value: 10 });
      expect(result.chunkTimestamp?.getTime()).toBe(exactTimestamp.getTime());
    });

    it('should return metadata including serial, branchId, and chunkTimestamp', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('AsOfTest5', testSchema, 'asof_test_5');
      await initializeChronicle(connection, 'asof_test_5');

      const doc = new TestModel({ name: 'MetadataTest' });
      await doc.save();

      await delay(50);
      doc.name = 'Updated';
      await doc.save();

      const result = await (TestModel as any).chronicleAsOf(doc._id, new Date());

      expect(result.found).toBe(true);
      expect(result.serial).toBe(2);
      expect(result.branchId).toBeDefined();
      expect(result.chunkTimestamp).toBeInstanceOf(Date);
    });
  });

  describe('Specific Branch Queries', () => {
    it('should query a specific branch using branchId option', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('AsOfTest6', testSchema, 'asof_test_6');
      await initializeChronicle(connection, 'asof_test_6');

      // Create document on main
      const doc = new TestModel({ name: 'Test', value: 1 });
      await doc.save();

      // Get main branch ID
      const mainBranch = await (TestModel as any).getActiveBranch(doc._id);

      // Create feature branch (auto-activates)
      const featureBranch = await (TestModel as any).createBranch(doc._id, 'feature');

      await delay(50);

      // Update on feature branch
      doc.value = 100;
      await doc.save();

      const queryTime = new Date();

      // Query main branch at current time
      const mainResult = await (TestModel as any).chronicleAsOf(doc._id, queryTime, {
        branchId: mainBranch._id,
      });

      expect(mainResult.found).toBe(true);
      expect(mainResult.state).toMatchObject({ name: 'Test', value: 1 });
      expect(mainResult.branchId.toString()).toBe(mainBranch._id.toString());

      // Query feature branch at current time
      const featureResult = await (TestModel as any).chronicleAsOf(doc._id, queryTime, {
        branchId: featureBranch._id,
      });

      expect(featureResult.found).toBe(true);
      expect(featureResult.state).toMatchObject({ name: 'Test', value: 100 });
      expect(featureResult.branchId.toString()).toBe(featureBranch._id.toString());
    });

    it('should return found: false when branch did not exist at timestamp', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('AsOfTest7', testSchema, 'asof_test_7');
      await initializeChronicle(connection, 'asof_test_7');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      const timeBeforeBranch = new Date();

      await delay(50);

      // Create branch after the timestamp
      const branch = await (TestModel as any).createBranch(doc._id, 'late-branch');

      // Query the new branch at time before it existed
      const result = await (TestModel as any).chronicleAsOf(doc._id, timeBeforeBranch, {
        branchId: branch._id,
      });

      expect(result.found).toBe(false);
    });
  });

  describe('Cross-Branch Search (searchAllBranches)', () => {
    it('should find state from branch with most recent chunk', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        source: { type: String },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('AsOfTest8', testSchema, 'asof_test_8');
      await initializeChronicle(connection, 'asof_test_8');

      // Create document on main
      const doc = new TestModel({ name: 'Test', source: 'main' });
      await doc.save();

      // Create branch A (auto-activates)
      await (TestModel as any).createBranch(doc._id, 'branch-a');

      await delay(50);

      // Update on branch A
      doc.source = 'branch-a';
      await doc.save();

      const queryTime = new Date();

      // Search all branches - should find branch-a as it has most recent chunk
      const result = await (TestModel as any).chronicleAsOf(doc._id, queryTime, {
        searchAllBranches: true,
      });

      expect(result.found).toBe(true);
      expect(result.state).toMatchObject({ name: 'Test', source: 'branch-a' });
    });

    it('should throw error when both branchId and searchAllBranches provided', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('AsOfTest9', testSchema, 'asof_test_9');
      await initializeChronicle(connection, 'asof_test_9');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      const branch = await (TestModel as any).getActiveBranch(doc._id);

      await expect(
        (TestModel as any).chronicleAsOf(doc._id, new Date(), {
          branchId: branch._id,
          searchAllBranches: true,
        })
      ).rejects.toThrow(/mutually exclusive/);
    });

    it('should return found: false when no branches have data at timestamp', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('AsOfTest10', testSchema, 'asof_test_10');
      await initializeChronicle(connection, 'asof_test_10');

      const veryOldTime = new Date('2000-01-01');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Create another branch
      await (TestModel as any).createBranch(doc._id, 'another');

      // Search all branches at a time before any data
      const result = await (TestModel as any).chronicleAsOf(doc._id, veryOldTime, {
        searchAllBranches: true,
      });

      expect(result.found).toBe(false);
    });
  });

  describe('Delta Rehydration', () => {
    it('should correctly rehydrate through multiple delta chunks', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        a: { type: Number },
        b: { type: Number },
        c: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('AsOfTest11', testSchema, 'asof_test_11');
      await initializeChronicle(connection, 'asof_test_11');

      // Create document (FULL chunk)
      const doc = new TestModel({ name: 'Test', a: 1, b: 1, c: 1 });
      await doc.save();

      await delay(20);

      // Update a (DELTA)
      doc.a = 2;
      await doc.save();
      const timeAfterA = new Date();

      await delay(20);

      // Update b (DELTA)
      doc.b = 2;
      await doc.save();
      const timeAfterB = new Date();

      await delay(20);

      // Update c (DELTA)
      doc.c = 2;
      await doc.save();

      // Query at different points
      const stateAtA = await (TestModel as any).chronicleAsOf(doc._id, timeAfterA);
      expect(stateAtA.state).toMatchObject({ name: 'Test', a: 2, b: 1, c: 1 });

      const stateAtB = await (TestModel as any).chronicleAsOf(doc._id, timeAfterB);
      expect(stateAtB.state).toMatchObject({ name: 'Test', a: 2, b: 2, c: 1 });
    });
  });

  describe('Edge Cases', () => {
    it('should return found: false for non-existent document', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('AsOfTest12', testSchema, 'asof_test_12');
      await initializeChronicle(connection, 'asof_test_12');

      const fakeId = new mongoose.Types.ObjectId();
      const result = await (TestModel as any).chronicleAsOf(fakeId, new Date());

      expect(result.found).toBe(false);
    });

    it('should use active branch by default when no options provided', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('AsOfTest13', testSchema, 'asof_test_13');
      await initializeChronicle(connection, 'asof_test_13');

      const doc = new TestModel({ name: 'Test', value: 1 });
      await doc.save();

      // Create and activate feature branch
      await (TestModel as any).createBranch(doc._id, 'feature');

      await delay(50);

      // Update on feature branch
      doc.value = 999;
      await doc.save();

      // Query without options - should use active branch (feature)
      const result = await (TestModel as any).chronicleAsOf(doc._id, new Date());

      expect(result.found).toBe(true);
      expect(result.state).toMatchObject({ name: 'Test', value: 999 });
    });
  });
});
