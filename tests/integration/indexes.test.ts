import mongoose, { Schema } from 'mongoose';
import {
  setupTestDatabase,
  clearTestDatabase,
  teardownTestDatabase,
  getConnection,
} from './setup';
import {
  chroniclePlugin,
  initializeChronicle,
  analyzeSchemaIndexes,
  createChronicleKeysSchema,
} from '../../src';

describe('Index and Unique Key Handling', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
    // Clean up models
    const modelNames = Object.keys(mongoose.models);
    for (const name of modelNames) {
      delete mongoose.models[name];
    }
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  describe('Schema Analysis Integration', () => {
    it('should analyze schema indexes when plugin is applied', () => {
      const TestSchema = new Schema({
        sku: { type: String, required: true, index: true, unique: true },
        name: { type: String, index: true },
        description: { type: String },
      });

      TestSchema.plugin(chroniclePlugin, { fullChunkInterval: 5 });

      // Access the stored options
      const chronicleSchema = TestSchema as Schema & { chronicleOptions?: { indexes?: string[]; uniqueKeys?: string[] } };

      expect(chronicleSchema.chronicleOptions).toBeDefined();
      expect(chronicleSchema.chronicleOptions?.indexes).toContain('sku');
      expect(chronicleSchema.chronicleOptions?.indexes).toContain('name');
      expect(chronicleSchema.chronicleOptions?.uniqueKeys).toContain('sku');
      expect(chronicleSchema.chronicleOptions?.uniqueKeys).not.toContain('name');
    });

    it('should allow overriding analyzed indexes via options', () => {
      const TestSchema = new Schema({
        sku: { type: String, index: true, unique: true },
        name: { type: String, index: true },
        category: { type: String },
      });

      TestSchema.plugin(chroniclePlugin, {
        indexes: ['category'], // Override: only index category
        uniqueKeys: [], // Override: no unique keys
      });

      const chronicleSchema = TestSchema as Schema & { chronicleOptions?: { indexes?: string[]; uniqueKeys?: string[] } };

      expect(chronicleSchema.chronicleOptions?.indexes).toEqual(['category']);
      expect(chronicleSchema.chronicleOptions?.uniqueKeys).toEqual([]);
    });
  });

  describe('Chronicle Keys Collection', () => {
    it('should create keys collection when unique fields exist', async () => {
      const TestSchema = new Schema({
        sku: { type: String, unique: true },
        name: { type: String },
      });

      const analysis = analyzeSchemaIndexes(TestSchema);

      await initializeChronicle(
        getConnection(),
        'test_with_unique',
        { uniqueKeys: ['sku'] },
        analysis
      );

      // Check that the keys collection model was created
      const keysModel = getConnection().models['ChronicleKeys_test_with_unique'];
      expect(keysModel).toBeDefined();
    });

    it('should not create keys collection when no unique fields', async () => {
      const TestSchema = new Schema({
        name: { type: String, index: true },
        description: { type: String },
      });

      const analysis = analyzeSchemaIndexes(TestSchema);

      await initializeChronicle(
        getConnection(),
        'test_no_unique',
        { uniqueKeys: [] },
        analysis
      );

      // Keys collection should not exist
      const keysModel = getConnection().models['ChronicleKeys_test_no_unique'];
      expect(keysModel).toBeUndefined();
    });

    it('should create unique indexes on keys collection for each unique field', async () => {
      const uniqueFields = ['sku', 'email'];
      const keysSchema = createChronicleKeysSchema(uniqueFields);

      // Check schema indexes
      const indexes = keysSchema.indexes();

      // Should have compound index for docId+branchId
      const docBranchIndex = indexes.find(([spec]) =>
        spec.docId === 1 && spec.branchId === 1
      );
      expect(docBranchIndex).toBeDefined();

      // Should have unique indexes for each unique field
      const skuIndex = indexes.find(([spec]) => spec.key_sku === 1);
      expect(skuIndex).toBeDefined();

      const emailIndex = indexes.find(([spec]) => spec.key_email === 1);
      expect(emailIndex).toBeDefined();
    });
  });

  describe('Chronicle Config Storage', () => {
    it('should store indexed fields in config', async () => {
      const TestSchema = new Schema({
        sku: { type: String, index: true, unique: true },
        name: { type: String, index: true },
      });

      const analysis = analyzeSchemaIndexes(TestSchema);

      await initializeChronicle(
        getConnection(),
        'test_config_indexes',
        { fullChunkInterval: 10 },
        analysis
      );

      const configCollection = getConnection().db!.collection('chronicle_config');
      const config = await configCollection.findOne({ collectionName: 'test_config_indexes' });

      expect(config).not.toBeNull();
      expect(config?.indexedFields).toContain('sku');
      expect(config?.indexedFields).toContain('name');
      expect(config?.uniqueFields).toContain('sku');
      expect(config?.uniqueFields).not.toContain('name');
    });
  });

  describe('ChronicleChunk Schema', () => {
    it('should have isLatest field', async () => {
      const { createChronicleChunkSchema } = await import('../../src/core/schemas');
      const chunkSchema = createChronicleChunkSchema();

      const isLatestPath = chunkSchema.path('isLatest');
      expect(isLatestPath).toBeDefined();
      expect(isLatestPath?.options.type).toBe(Boolean);
      expect(isLatestPath?.options.default).toBe(true);
    });

    it('should have chronicle_latest index', async () => {
      const { createChronicleChunkSchema } = await import('../../src/core/schemas');
      const chunkSchema = createChronicleChunkSchema();

      const indexes = chunkSchema.indexes();
      const latestIndex = indexes.find(([, options]) =>
        options?.name === 'chronicle_latest'
      );

      expect(latestIndex).toBeDefined();
    });

    it('should have chronicle_lookup compound index', async () => {
      const { createChronicleChunkSchema } = await import('../../src/core/schemas');
      const chunkSchema = createChronicleChunkSchema();

      const indexes = chunkSchema.indexes();
      const lookupIndex = indexes.find(([, options]) =>
        options?.name === 'chronicle_lookup'
      );

      expect(lookupIndex).toBeDefined();
      expect(lookupIndex?.[0]).toEqual({ docId: 1, epoch: 1, branchId: 1, serial: -1 });
    });
  });
});
