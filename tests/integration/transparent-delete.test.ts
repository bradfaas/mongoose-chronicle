/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */
import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { chroniclePlugin, initializeChronicle } from '../../src';

describe('Transparent Soft Delete', () => {
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
    // Clear models
    connection.deleteModel(/.*/);
  });

  describe('findOneAndDelete middleware', () => {
    it('should create deletion chunk and set __chronicle_deleted', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        price: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('TransDelete1', testSchema, 'trans_delete_1');
      await initializeChronicle(connection, 'trans_delete_1');

      // Create document
      const doc = new TestModel({ name: 'Product', price: 100 });
      await doc.save();

      // Delete using findOneAndDelete
      await TestModel.findOneAndDelete({ _id: doc._id });

      // Verify document still exists but is marked deleted
      const mainDoc = await connection.db?.collection('trans_delete_1').findOne({ _id: doc._id });
      expect(mainDoc).toBeDefined();
      expect(mainDoc?.__chronicle_deleted).toBe(true);

      // Verify deletion chunk was created
      const chunks = await connection.db?.collection('trans_delete_1_chronicle_chunks')
        .find({ docId: doc._id })
        .sort({ serial: 1 })
        .toArray();

      expect(chunks).toHaveLength(2);
      expect(chunks?.[1]?.isDeleted).toBe(true);
      expect(chunks?.[1]?.isLatest).toBe(true);
    });

    it('should work with findByIdAndDelete', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('TransDelete2', testSchema, 'trans_delete_2');
      await initializeChronicle(connection, 'trans_delete_2');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      await TestModel.findByIdAndDelete(doc._id);

      const mainDoc = await connection.db?.collection('trans_delete_2').findOne({ _id: doc._id });
      expect(mainDoc?.__chronicle_deleted).toBe(true);
    });
  });

  describe('deleteOne middleware', () => {
    it('should soft-delete document via deleteOne query', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        category: { type: String },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('TransDelete3', testSchema, 'trans_delete_3');
      await initializeChronicle(connection, 'trans_delete_3');

      const doc = new TestModel({ name: 'Item', category: 'electronics' });
      await doc.save();

      await TestModel.deleteOne({ category: 'electronics' });

      const mainDoc = await connection.db?.collection('trans_delete_3').findOne({ _id: doc._id });
      expect(mainDoc?.__chronicle_deleted).toBe(true);

      // Verify deletion chunk
      const chunks = await connection.db?.collection('trans_delete_3_chronicle_chunks')
        .find({ docId: doc._id, isDeleted: true })
        .toArray();
      expect(chunks).toHaveLength(1);
    });
  });

  describe('deleteMany middleware', () => {
    it('should soft-delete multiple documents', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        category: { type: String },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('TransDelete4', testSchema, 'trans_delete_4');
      await initializeChronicle(connection, 'trans_delete_4');

      // Create multiple documents
      const doc1 = new TestModel({ name: 'Item1', category: 'books' });
      const doc2 = new TestModel({ name: 'Item2', category: 'books' });
      const doc3 = new TestModel({ name: 'Item3', category: 'electronics' });
      await doc1.save();
      await doc2.save();
      await doc3.save();

      // Delete all books
      await TestModel.deleteMany({ category: 'books' });

      // Verify books are soft deleted
      const book1 = await connection.db?.collection('trans_delete_4').findOne({ _id: doc1._id });
      const book2 = await connection.db?.collection('trans_delete_4').findOne({ _id: doc2._id });
      const electronics = await connection.db?.collection('trans_delete_4').findOne({ _id: doc3._id });

      expect(book1?.__chronicle_deleted).toBe(true);
      expect(book2?.__chronicle_deleted).toBe(true);
      expect(electronics?.__chronicle_deleted).not.toBe(true);
    });

    it('should throw error if deleteMany affects > limit documents', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        category: { type: String },
      });
      testSchema.plugin(chroniclePlugin, { deleteManyLimit: 5 });

      const TestModel = connection.model('TransDelete5', testSchema, 'trans_delete_5');
      await initializeChronicle(connection, 'trans_delete_5');

      // Create 10 documents
      for (let i = 0; i < 10; i++) {
        const doc = new TestModel({ name: `Item${i}`, category: 'bulk' });
        await doc.save();
      }

      // Attempt to delete all - should throw
      await expect(
        TestModel.deleteMany({ category: 'bulk' })
      ).rejects.toThrow(/exceeding limit of 5/);
    });

    it('should allow bypass with chronicleForceDeleteMany option', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        category: { type: String },
      });
      testSchema.plugin(chroniclePlugin, { deleteManyLimit: 5 });

      const TestModel = connection.model('TransDelete6', testSchema, 'trans_delete_6');
      await initializeChronicle(connection, 'trans_delete_6');

      // Create 10 documents
      for (let i = 0; i < 10; i++) {
        const doc = new TestModel({ name: `Item${i}`, category: 'bulk' });
        await doc.save();
      }

      // Delete with bypass flag - should succeed
      await TestModel.deleteMany({ category: 'bulk' }, { chronicleForceDeleteMany: true } as any);

      // Verify all deleted
      const docs = await connection.db?.collection('trans_delete_6')
        .find({ __chronicle_deleted: true })
        .toArray();
      expect(docs).toHaveLength(10);
    });
  });

  describe('Query filtering', () => {
    it('should auto-exclude deleted documents from find()', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('TransDelete7', testSchema, 'trans_delete_7');
      await initializeChronicle(connection, 'trans_delete_7');

      const doc1 = new TestModel({ name: 'Active' });
      const doc2 = new TestModel({ name: 'ToDelete' });
      await doc1.save();
      await doc2.save();

      await TestModel.findByIdAndDelete(doc2._id);

      // Regular find should only return active document
      const results = await TestModel.find({});
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe('Active');
    });

    it('should include deleted documents with includeDeleted option', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('TransDelete8', testSchema, 'trans_delete_8');
      await initializeChronicle(connection, 'trans_delete_8');

      const doc1 = new TestModel({ name: 'Active' });
      const doc2 = new TestModel({ name: 'Deleted' });
      await doc1.save();
      await doc2.save();

      await TestModel.findByIdAndDelete(doc2._id);

      // With includeDeleted option
      const results = await TestModel.find({}, null, { includeDeleted: true } as any);
      expect(results).toHaveLength(2);
    });

    it('should include deleted documents with includeDeleted() chain method', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('TransDelete9', testSchema, 'trans_delete_9');
      await initializeChronicle(connection, 'trans_delete_9');

      const doc1 = new TestModel({ name: 'Active' });
      const doc2 = new TestModel({ name: 'Deleted' });
      await doc1.save();
      await doc2.save();

      await TestModel.findByIdAndDelete(doc2._id);

      // With chain method
      const results = await (TestModel.find({}) as any).includeDeleted();
      expect(results).toHaveLength(2);
    });

    it('should auto-exclude deleted documents from findOne()', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('TransDelete10', testSchema, 'trans_delete_10');
      await initializeChronicle(connection, 'trans_delete_10');

      const doc = new TestModel({ name: 'ToDelete' });
      await doc.save();

      await TestModel.findByIdAndDelete(doc._id);

      // findOne should not find deleted document
      const result = await TestModel.findOne({ name: 'ToDelete' });
      expect(result).toBeNull();

      // findOne with includeDeleted should find it
      const resultWithDeleted = await TestModel.findOne(
        { name: 'ToDelete' },
        null,
        { includeDeleted: true } as any
      );
      expect(resultWithDeleted).not.toBeNull();
    });
  });

  describe('Branch recovery', () => {
    it('should restore document in main collection when branching from deleted document', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        version: { type: Number, default: 1 },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('TransDelete11', testSchema, 'trans_delete_11');
      await initializeChronicle(connection, 'trans_delete_11');

      // Create and update document
      const doc = new TestModel({ name: 'Original', version: 1 });
      await doc.save();
      doc.version = 2;
      await doc.save();

      // Soft delete
      await TestModel.findByIdAndDelete(doc._id);

      // Verify deleted in main collection
      const deletedDoc = await TestModel.findById(doc._id);
      expect(deletedDoc).toBeNull();

      // Create branch from serial 1 (before any updates)
      const branch = await (TestModel as any).createBranch(doc._id, 'recovery-branch', { fromSerial: 1 });
      expect(branch).toBeDefined();

      // Document should be restored in main collection
      const restoredDoc = await TestModel.findById(doc._id);
      expect(restoredDoc).not.toBeNull();
      expect(restoredDoc?.name).toBe('Original');
      expect(restoredDoc?.version).toBe(1);
      expect((restoredDoc as any).__chronicle_deleted).toBe(false);
    });
  });

  describe('switchBranch state sync', () => {
    it('should mark document as deleted when switching to deleted branch', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('TransDelete12', testSchema, 'trans_delete_12');
      await initializeChronicle(connection, 'trans_delete_12');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Create a branch before deletion
      const branch = await (TestModel as any).createBranch(doc._id, 'pre-delete', { activate: false });

      // Delete on main branch
      await TestModel.findByIdAndDelete(doc._id);

      // Verify deleted
      let mainDoc = await connection.db?.collection('trans_delete_12').findOne({ _id: doc._id });
      expect(mainDoc?.__chronicle_deleted).toBe(true);

      // Switch to pre-delete branch (which has the document active)
      await (TestModel as any).switchBranch(doc._id, branch._id);

      // Document should be restored
      mainDoc = await connection.db?.collection('trans_delete_12').findOne({ _id: doc._id });
      expect(mainDoc?.__chronicle_deleted).toBe(false);
      expect(mainDoc?.name).toBe('Test');
    });

    it('should sync document state when switching between branches', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number, default: 0 },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('TransDelete13', testSchema, 'trans_delete_13');
      await initializeChronicle(connection, 'trans_delete_13');

      const doc = new TestModel({ name: 'Test', value: 1 });
      await doc.save();

      // Create a branch
      const branch = await (TestModel as any).createBranch(doc._id, 'feature-branch');

      // Update on feature branch
      const featureDoc = await TestModel.findById(doc._id);
      featureDoc!.value = 100;
      await featureDoc!.save();

      // Get main branch
      const branches = await (TestModel as any).listBranches(doc._id);
      const mainBranch = branches.find((b: any) => b.name === 'main');

      // Switch back to main branch
      await (TestModel as any).switchBranch(doc._id, mainBranch._id);

      // Document should reflect main branch state (value: 1)
      const mainDoc = await connection.db?.collection('trans_delete_13').findOne({ _id: doc._id });
      expect(mainDoc?.value).toBe(1);

      // Switch to feature branch
      await (TestModel as any).switchBranch(doc._id, branch._id);

      // Document should reflect feature branch state (value: 100)
      const featureDocState = await connection.db?.collection('trans_delete_13').findOne({ _id: doc._id });
      expect(featureDocState?.value).toBe(100);
    });
  });

  describe('chronicleUndelete with main collection sync', () => {
    it('should restore document in main collection when using chronicleUndelete', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        data: { type: String },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('TransDelete14', testSchema, 'trans_delete_14');
      await initializeChronicle(connection, 'trans_delete_14');

      const doc = new TestModel({ name: 'Important', data: 'valuable' });
      await doc.save();

      // Soft delete via findOneAndDelete
      await TestModel.findByIdAndDelete(doc._id);

      // Verify not findable
      const deleted = await TestModel.findById(doc._id);
      expect(deleted).toBeNull();

      // Undelete
      const result = await (TestModel as any).chronicleUndelete(doc._id);
      expect(result.success).toBe(true);

      // Document should be back
      const restored = await TestModel.findById(doc._id);
      expect(restored).not.toBeNull();
      expect(restored?.name).toBe('Important');
      expect(restored?.data).toBe('valuable');
      expect((restored as any).__chronicle_deleted).toBe(false);
    });
  });
});
