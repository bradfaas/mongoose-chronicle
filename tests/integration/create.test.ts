import {
  setupTestDatabase,
  clearTestDatabase,
  teardownTestDatabase,
  getConnection,
} from './setup';
import { createTestModels } from './test-schemas';
import { initializeChronicle } from '../../src';

// Type for documents with chronicle methods
interface ChronicleDocumentMethods {
  getHistory: () => Promise<unknown[]>;
  createSnapshot: (name: string) => Promise<unknown>;
  getBranches: () => Promise<unknown[]>;
}

// Type for models with chronicle static methods
interface ChronicleModelMethods {
  findAsOf: (filter: Record<string, unknown>, asOf: Date) => Promise<unknown>;
  createBranch: (docId: unknown, name: string) => Promise<unknown>;
  switchBranch: (docId: unknown, branchId: unknown) => Promise<void>;
  listBranches: (docId: unknown) => Promise<unknown[]>;
}

describe('Document Creation with Chronicle Plugin', () => {
  let Hardware: ReturnType<typeof createTestModels>['Hardware'];
  let ChronicledHardware: ReturnType<typeof createTestModels>['ChronicledHardware'];

  beforeAll(async () => {
    await setupTestDatabase();
    const models = createTestModels();
    Hardware = models.Hardware;
    ChronicledHardware = models.ChronicledHardware;

    // Initialize chronicle for the chronicled collection
    await initializeChronicle(getConnection(), 'chronicled_hardware', {
      fullChunkInterval: 5,
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  describe('Standard Mongoose (without plugin)', () => {
    it('should create a document normally', async () => {
      const doc = await Hardware.create({
        sku: 'TEST-001',
        description: 'Test Hardware',
        price: 99.99,
      });

      expect(doc.sku).toBe('TEST-001');
      expect(doc.description).toBe('Test Hardware');
      expect(doc.price).toBe(99.99);
      expect(doc._id).toBeDefined();
    });

    it('should find the created document', async () => {
      await Hardware.create({
        sku: 'TEST-002',
        description: 'Another Test',
        price: 49.99,
      });

      const found = await Hardware.findOne({ sku: 'TEST-002' });
      expect(found).not.toBeNull();
      expect(found?.description).toBe('Another Test');
    });
  });

  describe('With Chronicle Plugin', () => {
    it('should create a document with the plugin applied', async () => {
      const doc = await ChronicledHardware.create({
        sku: 'CHRON-001',
        description: 'Chronicled Hardware',
        price: 199.99,
      });

      expect(doc.sku).toBe('CHRON-001');
      expect(doc.description).toBe('Chronicled Hardware');
      expect(doc.price).toBe(199.99);
      expect(doc._id).toBeDefined();
    });

    it('should find a created document', async () => {
      await ChronicledHardware.create({
        sku: 'CHRON-002',
        description: 'Another Chronicled Item',
        price: 299.99,
      });

      const found = await ChronicledHardware.findOne({ sku: 'CHRON-002' });
      expect(found).not.toBeNull();
      expect(found?.description).toBe('Another Chronicled Item');
    });

    it('should have chronicle instance methods available', async () => {
      const doc = await ChronicledHardware.create({
        sku: 'CHRON-003',
        description: 'Item with methods',
        price: 399.99,
      });

      // Cast to access chronicle methods added by plugin
      const chronicleDoc = doc as unknown as ChronicleDocumentMethods;

      // Verify instance methods exist
      expect(typeof chronicleDoc.getHistory).toBe('function');
      expect(typeof chronicleDoc.createSnapshot).toBe('function');
      expect(typeof chronicleDoc.getBranches).toBe('function');
    });

    it('should have chronicle static methods available', async () => {
      // Cast to access chronicle static methods added by plugin
      const chronicleModel = ChronicledHardware as unknown as ChronicleModelMethods;

      // Verify static methods exist on the model
      expect(typeof chronicleModel.findAsOf).toBe('function');
      expect(typeof chronicleModel.createBranch).toBe('function');
      expect(typeof chronicleModel.switchBranch).toBe('function');
      expect(typeof chronicleModel.listBranches).toBe('function');
    });
  });

  describe('Chronicle Configuration', () => {
    it('should create chronicle_config collection entry', async () => {
      const configCollection = getConnection().collection('chronicle_config');
      const config = await configCollection.findOne({
        collectionName: 'chronicled_hardware',
      });

      expect(config).not.toBeNull();
      expect(config?.fullChunkInterval).toBe(5);
      expect(config?.pluginVersion).toBe('1.0.0');
    });
  });
});
