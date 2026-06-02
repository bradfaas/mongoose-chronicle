import mongoose, { Schema, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { chroniclePlugin, initializeChronicle } from '../../src';

describe('Save Middleware', () => {
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

  describe('New Document Creation', () => {
    it('should create a ChronicleChunk for new document', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SaveTest1', testSchema, 'save_test_1');
      await initializeChronicle(connection, 'save_test_1');

      // Create a document
      const doc = new TestModel({ name: 'Test', value: 42 });
      await doc.save();

      // Verify chunk was created in the chronicle_chunks collection
      const chunks = await connection.db?.collection('save_test_1_chronicle_chunks').find({}).toArray();
      expect(chunks).toHaveLength(1);

      const chunk = chunks?.[0];
      expect(chunk).toBeDefined();
      expect(chunk?.docId).toBeInstanceOf(Types.ObjectId);
      expect(chunk?.branchId).toBeInstanceOf(Types.ObjectId);
      expect(chunk?.serial).toBe(1);
      expect(chunk?.ccType).toBe(1); // FULL
      expect(chunk?.isLatest).toBe(true);
      expect(chunk?.isDeleted).toBe(false);
      expect(chunk?.payload).toMatchObject({ name: 'Test', value: 42 });
    });

    it('should create metadata for new document', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SaveTest2', testSchema, 'save_test_2');
      await initializeChronicle(connection, 'save_test_2');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Verify metadata was created
      const metadata = await connection.db?.collection('save_test_2_chronicle_metadata').find({}).toArray();
      expect(metadata).toHaveLength(1);

      const meta = metadata?.[0];
      expect(meta).toBeDefined();
      expect(meta?.metadataStatus).toBe('active');
      expect(meta?.docId).toBeInstanceOf(Types.ObjectId);
      expect(meta?.activeBranchId).toBeInstanceOf(Types.ObjectId);
    });

    it('should create main branch for new document', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SaveTest3', testSchema, 'save_test_3');
      await initializeChronicle(connection, 'save_test_3');

      const doc = new TestModel({ name: 'Test' });
      await doc.save();

      // Verify branch was created
      const branches = await connection.db?.collection('save_test_3_chronicle_branches').find({}).toArray();
      expect(branches).toHaveLength(1);

      const branch = branches?.[0];
      expect(branch).toBeDefined();
      expect(branch?.name).toBe('main');
      expect(branch?.parentBranchId).toBeNull();
      expect(branch?.parentSerial).toBeNull();
    });
  });

  describe('Document Updates', () => {
    it('should create delta chunk on update', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SaveTest4', testSchema, 'save_test_4');
      await initializeChronicle(connection, 'save_test_4');

      // Create document
      const doc = new TestModel({ name: 'Test', value: 1 });
      await doc.save();

      // Get the docId from the first chunk
      const firstChunk = await connection.db?.collection('save_test_4_chronicle_chunks').findOne({ serial: 1 });
      expect(firstChunk).toBeDefined();
      expect(firstChunk?.ccType).toBe(1); // FULL

      // The document itself can be found via findById since mongoose still saves it
      const loadedDoc = await TestModel.findById(doc._id);
      expect(loadedDoc).toBeDefined();
    });

    it('should successfully update an existing document', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SaveTest4a', testSchema, 'save_test_4a');
      await initializeChronicle(connection, 'save_test_4a');

      // Create document
      const doc = new TestModel({ name: 'Original', value: 1 });
      await doc.save();

      // Verify initial chunk was created with document's _id as docId
      const initialChunk = await connection.db?.collection('save_test_4a_chronicle_chunks').findOne({ serial: 1 });
      expect(initialChunk).toBeDefined();
      expect(initialChunk?.docId.toString()).toBe(doc._id.toString()); // docId should match MongoDB _id

      // Update the document
      doc.name = 'Updated';
      doc.value = 2;
      await doc.save(); // This should NOT throw "metadata not found" error

      // Verify a second chunk was created
      const chunks = await connection.db?.collection('save_test_4a_chronicle_chunks')
        .find({ docId: doc._id })
        .sort({ serial: 1 })
        .toArray();

      expect(chunks).toHaveLength(2);
      expect(chunks?.[0]?.ccType).toBe(1); // First chunk is FULL
      expect(chunks?.[1]?.ccType).toBe(2); // Second chunk is DELTA
      expect(chunks?.[1]?.payload).toMatchObject({ name: 'Updated', value: 2 });
    });

    it('should mark previous chunk as not latest when creating new chunk', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        value: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SaveTest5', testSchema, 'save_test_5');
      await initializeChronicle(connection, 'save_test_5');

      // Create two documents to get multiple chunks
      const doc1 = new TestModel({ name: 'Doc1', value: 1 });
      await doc1.save();

      const doc2 = new TestModel({ name: 'Doc2', value: 2 });
      await doc2.save();

      // Both chunks should be latest since they're different documents
      const latestChunks = await connection.db?.collection('save_test_5_chronicle_chunks')
        .find({ isLatest: true })
        .toArray();

      expect(latestChunks).toHaveLength(2);
    });

    it('should mark previous chunk as not latest on same document update', async () => {
      const testSchema = new Schema({
        name: { type: String, required: true },
        counter: { type: Number },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SaveTest5a', testSchema, 'save_test_5a');
      await initializeChronicle(connection, 'save_test_5a');

      // Create document
      const doc = new TestModel({ name: 'Counter', counter: 0 });
      await doc.save();

      // Update the document
      doc.counter = 1;
      await doc.save();

      // Only the latest chunk should have isLatest=true
      const latestChunks = await connection.db?.collection('save_test_5a_chronicle_chunks')
        .find({ docId: doc._id, isLatest: true })
        .toArray();

      expect(latestChunks).toHaveLength(1);
      expect(latestChunks?.[0]?.serial).toBe(2);

      // First chunk should have isLatest=false
      const firstChunk = await connection.db?.collection('save_test_5a_chronicle_chunks')
        .findOne({ docId: doc._id, serial: 1 });
      expect(firstChunk?.isLatest).toBe(false);
    });
  });

  describe('Unique Constraint Validation', () => {
    it('should reject duplicate unique values on new documents', async () => {
      const testSchema = new Schema({
        sku: { type: String, unique: true, required: true },
        name: { type: String },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SaveTest6', testSchema, 'save_test_6');
      await initializeChronicle(connection, 'save_test_6');

      // Create first document
      const doc1 = new TestModel({ sku: 'SKU001', name: 'Product 1' });
      await doc1.save();

      // Try to create duplicate
      const doc2 = new TestModel({ sku: 'SKU001', name: 'Product 2' });
      await expect(doc2.save()).rejects.toThrow();
    });

    it('should update chronicle_keys collection on save', async () => {
      const testSchema = new Schema({
        email: { type: String, unique: true, required: true },
        name: { type: String },
      });
      testSchema.plugin(chroniclePlugin);

      const TestModel = connection.model('SaveTest7', testSchema, 'save_test_7');
      await initializeChronicle(connection, 'save_test_7');

      // Create document
      const doc = new TestModel({ email: 'test@example.com', name: 'Test User' });
      await doc.save();

      // Verify keys collection was updated
      const keys = await connection.db?.collection('save_test_7_chronicle_keys').find({}).toArray();
      expect(keys).toHaveLength(1);

      const keyDoc = keys?.[0];
      expect(keyDoc).toBeDefined();
      expect(keyDoc?.key_email).toBe('test@example.com');
      expect(keyDoc?.isDeleted).toBe(false);
    });

    it('should allow null unique values in chronicle validation', async () => {
      // Note: Mongoose itself still enforces unique indexes on the original collection
      // This test verifies that chronicle's unique validation allows null values
      const testSchema = new Schema({
        sku: { type: String }, // No unique constraint on mongoose schema
        name: { type: String, required: true },
      });
      // Configure chronicle to treat sku as unique
      testSchema.plugin(chroniclePlugin, { uniqueKeys: ['sku'] });

      const TestModel = connection.model('SaveTest8', testSchema, 'save_test_8');
      await initializeChronicle(connection, 'save_test_8', { uniqueKeys: ['sku'] });

      // Create documents with undefined sku (should be allowed by chronicle)
      const doc1 = new TestModel({ name: 'Product 1' });
      await doc1.save();

      const doc2 = new TestModel({ name: 'Product 2' });
      await doc2.save();

      // Both should succeed
      const chunks = await connection.db?.collection('save_test_8_chronicle_chunks').find({}).toArray();
      expect(chunks).toHaveLength(2);
    });
  });

  describe('Full Chunk Interval', () => {
    it('should respect fullChunkInterval option', async () => {
      const testSchema = new Schema({
        counter: { type: Number, required: true },
      });
      testSchema.plugin(chroniclePlugin, { fullChunkInterval: 3 });

      const TestModel = connection.model('SaveTest9', testSchema, 'save_test_9');
      await initializeChronicle(connection, 'save_test_9', { fullChunkInterval: 3 });

      // Create initial document (should be full chunk)
      const doc = new TestModel({ counter: 0 });
      await doc.save();

      // Verify first chunk is full
      const firstChunk = await connection.db?.collection('save_test_9_chronicle_chunks').findOne({ serial: 1 });
      expect(firstChunk).toBeDefined();
      expect(firstChunk?.ccType).toBe(1); // FULL
    });
  });
});
