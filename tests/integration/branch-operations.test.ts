import mongoose, { Schema, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { chroniclePlugin, initializeChronicle } from '../../src';

describe('Branch Operations', () => {
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

  describe('createBranch', () => {
    it('should create a new branch and activate it by default', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('BranchTest1', testSchema, 'branch_test_1');
      await initializeChronicle(connection, 'branch_test_1');

      // Create a document
      const doc = new TestModel({ name: 'Test', value: 1 });
      await doc.save();

      // Create a branch
      const branch = await (TestModel as any).createBranch(doc._id, 'feature-x');

      expect(branch).toBeDefined();
      expect(branch.name).toBe('feature-x');
      expect(branch.docId.toString()).toBe(doc._id.toString());
      expect(branch.parentSerial).toBe(1);

      // Verify the branch was activated (activeBranchId updated in metadata)
      const metadata = await connection.db?.collection('branch_test_1_chronicle_metadata').findOne({ docId: doc._id });
      expect(metadata?.activeBranchId.toString()).toBe(branch._id.toString());
    });

    it('should create a branch without activating when activate: false', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('BranchTest2', testSchema, 'branch_test_2');
      await initializeChronicle(connection, 'branch_test_2');

      // Create a document
      const doc = new TestModel({ name: 'Test', value: 1 });
      await doc.save();

      // Get the main branch ID before creating new branch
      const metadataBefore = await connection.db?.collection('branch_test_2_chronicle_metadata').findOne({ docId: doc._id });
      const mainBranchId = metadataBefore?.activeBranchId;

      // Create a branch without activating
      const branch = await (TestModel as any).createBranch(doc._id, 'archived-snapshot', { activate: false });

      expect(branch).toBeDefined();
      expect(branch.name).toBe('archived-snapshot');

      // Verify the active branch is still main
      const metadataAfter = await connection.db?.collection('branch_test_2_chronicle_metadata').findOne({ docId: doc._id });
      expect(metadataAfter?.activeBranchId.toString()).toBe(mainBranchId.toString());
    });

    it('should create a FULL chunk on the new branch', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('BranchTest3', testSchema, 'branch_test_3');
      await initializeChronicle(connection, 'branch_test_3');

      // Create a document
      const doc = new TestModel({ name: 'Test', value: 42 });
      await doc.save();

      // Create a branch
      const branch = await (TestModel as any).createBranch(doc._id, 'feature-x');

      // Verify the new branch has a FULL chunk
      const branchChunks = await connection.db?.collection('branch_test_3_chronicle_chunks')
        .find({ branchId: branch._id })
        .toArray();

      expect(branchChunks).toHaveLength(1);
      expect(branchChunks?.[0]?.ccType).toBe(1); // FULL
      expect(branchChunks?.[0]?.serial).toBe(1);
      expect(branchChunks?.[0]?.payload).toMatchObject({ name: 'Test', value: 42 });
    });

    it('should branch from a specific serial when fromSerial is provided', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        counter: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('BranchTest4', testSchema, 'branch_test_4');
      await initializeChronicle(connection, 'branch_test_4');

      // Create a document and make multiple updates
      const doc = new TestModel({ name: 'Test', counter: 1 });
      await doc.save(); // serial 1

      doc.counter = 2;
      await doc.save(); // serial 2

      doc.counter = 3;
      await doc.save(); // serial 3

      // Create a branch from serial 2 (when counter was 2)
      const branch = await (TestModel as any).createBranch(doc._id, 'from-serial-2', { fromSerial: 2 });

      expect(branch.parentSerial).toBe(2);

      // Verify the branch chunk has the state at serial 2
      const branchChunk = await connection.db?.collection('branch_test_4_chronicle_chunks')
        .findOne({ branchId: branch._id, serial: 1 });

      expect(branchChunk?.payload).toMatchObject({ name: 'Test', counter: 2 });
    });

    it('should record subsequent saves on the new branch after activation', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('BranchTest5', testSchema, 'branch_test_5');
      await initializeChronicle(connection, 'branch_test_5');

      // Create a document
      const doc = new TestModel({ name: 'Test', value: 1 });
      await doc.save(); // main serial 1

      // Create and activate a new branch
      const branch = await (TestModel as any).createBranch(doc._id, 'feature-x');

      // Update the document - should go to the new branch
      doc.value = 100;
      await doc.save();

      // Verify the update went to the feature branch, not main
      const featureChunks = await connection.db?.collection('branch_test_5_chronicle_chunks')
        .find({ branchId: branch._id })
        .sort({ serial: 1 })
        .toArray();

      expect(featureChunks).toHaveLength(2); // Initial FULL + new DELTA
      expect(featureChunks?.[1]?.serial).toBe(2);
      expect(featureChunks?.[1]?.payload).toMatchObject({ value: 100 });

      // Verify main branch still only has 1 chunk
      const mainBranch = await connection.db?.collection('branch_test_5_chronicle_branches')
        .findOne({ docId: doc._id, name: 'main' });
      const mainChunks = await connection.db?.collection('branch_test_5_chronicle_chunks')
        .find({ branchId: mainBranch?._id })
        .toArray();

      expect(mainChunks).toHaveLength(1);
    });
  });

  describe('switchBranch', () => {
    it('should switch the active branch', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('BranchTest6', testSchema, 'branch_test_6');
      await initializeChronicle(connection, 'branch_test_6');

      // Create a document
      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Create a branch (auto-activates)
      const featureBranch = await (TestModel as any).createBranch(doc._id, 'feature-x');

      // Get main branch
      const mainBranch = await connection.db?.collection('branch_test_6_chronicle_branches')
        .findOne({ docId: doc._id, name: 'main' });

      // Switch back to main
      await (TestModel as any).switchBranch(doc._id, mainBranch?._id);

      // Verify active branch is main
      const metadata = await connection.db?.collection('branch_test_6_chronicle_metadata').findOne({ docId: doc._id });
      expect(metadata?.activeBranchId.toString()).toBe(mainBranch?._id.toString());

      // Switch to feature branch
      await (TestModel as any).switchBranch(doc._id, featureBranch._id);

      // Verify active branch is feature
      const metadata2 = await connection.db?.collection('branch_test_6_chronicle_metadata').findOne({ docId: doc._id });
      expect(metadata2?.activeBranchId.toString()).toBe(featureBranch._id.toString());
    });

    it('should throw error for non-existent branch', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('BranchTest7', testSchema, 'branch_test_7');
      await initializeChronicle(connection, 'branch_test_7');

      // Create a document
      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Try to switch to a non-existent branch
      const fakeBranchId = new Types.ObjectId();
      await expect((TestModel as any).switchBranch(doc._id, fakeBranchId))
        .rejects.toThrow(`Branch ${fakeBranchId} not found for document ${doc._id}`);
    });
  });

  describe('listBranches', () => {
    it('should list all branches for a document', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('BranchTest8', testSchema, 'branch_test_8');
      await initializeChronicle(connection, 'branch_test_8');

      // Create a document
      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Create multiple branches
      await (TestModel as any).createBranch(doc._id, 'feature-a', { activate: false });
      await (TestModel as any).createBranch(doc._id, 'feature-b', { activate: false });
      await (TestModel as any).createBranch(doc._id, 'feature-c', { activate: false });

      // List branches
      const branches = await (TestModel as any).listBranches(doc._id);

      expect(branches).toHaveLength(4); // main + 3 feature branches
      const branchNames = branches.map((b: any) => b.name);
      expect(branchNames).toContain('main');
      expect(branchNames).toContain('feature-a');
      expect(branchNames).toContain('feature-b');
      expect(branchNames).toContain('feature-c');
    });

    it('should return branches ordered by creation time', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('BranchTest9', testSchema, 'branch_test_9');
      await initializeChronicle(connection, 'branch_test_9');

      // Create a document
      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Create branches in order
      await (TestModel as any).createBranch(doc._id, 'first', { activate: false });
      await (TestModel as any).createBranch(doc._id, 'second', { activate: false });
      await (TestModel as any).createBranch(doc._id, 'third', { activate: false });

      // List branches
      const branches = await (TestModel as any).listBranches(doc._id);

      expect(branches[0].name).toBe('main');
      expect(branches[1].name).toBe('first');
      expect(branches[2].name).toBe('second');
      expect(branches[3].name).toBe('third');
    });
  });

  describe('getActiveBranch', () => {
    it('should return the currently active branch', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('BranchTest10', testSchema, 'branch_test_10');
      await initializeChronicle(connection, 'branch_test_10');

      // Create a document
      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Get active branch (should be main)
      const activeBranch = await (TestModel as any).getActiveBranch(doc._id);
      expect(activeBranch).toBeDefined();
      expect(activeBranch.name).toBe('main');

      // Create and activate a new branch
      const featureBranch = await (TestModel as any).createBranch(doc._id, 'feature-x');

      // Get active branch (should be feature-x)
      const activeBranch2 = await (TestModel as any).getActiveBranch(doc._id);
      expect(activeBranch2.name).toBe('feature-x');
      expect(activeBranch2._id.toString()).toBe(featureBranch._id.toString());
    });
  });
});
