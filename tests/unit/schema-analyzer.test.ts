import { Schema } from 'mongoose';
import {
  analyzeSchemaIndexes,
  createCleanPayloadSchema,
  generateChronicleIndexes,
} from '../../src/utils/schema-analyzer';

describe('Schema Analyzer', () => {
  describe('analyzeSchemaIndexes', () => {
    it('should detect indexed fields', () => {
      const schema = new Schema({
        name: { type: String, index: true },
        email: { type: String },
        age: { type: Number, index: true },
      });

      const analysis = analyzeSchemaIndexes(schema);

      expect(analysis.indexedFields).toHaveLength(2);
      expect(analysis.indexedFields.map(f => f.path)).toContain('name');
      expect(analysis.indexedFields.map(f => f.path)).toContain('age');
    });

    it('should detect unique fields', () => {
      const schema = new Schema({
        sku: { type: String, unique: true },
        name: { type: String },
        email: { type: String, unique: true },
      });

      const analysis = analyzeSchemaIndexes(schema);

      expect(analysis.uniqueFields).toHaveLength(2);
      expect(analysis.uniqueFields.map(f => f.path)).toContain('sku');
      expect(analysis.uniqueFields.map(f => f.path)).toContain('email');
    });

    it('should detect fields that are both indexed and unique', () => {
      const schema = new Schema({
        sku: { type: String, index: true, unique: true },
        name: { type: String },
      });

      const analysis = analyzeSchemaIndexes(schema);

      expect(analysis.indexedFields).toHaveLength(1);
      expect(analysis.uniqueFields).toHaveLength(1);
      expect(analysis.indexedFields[0]?.path).toBe('sku');
      expect(analysis.indexedFields[0]?.unique).toBe(true);
    });

    it('should detect required fields', () => {
      const schema = new Schema({
        sku: { type: String, required: true, unique: true },
        name: { type: String, index: true },
      });

      const analysis = analyzeSchemaIndexes(schema);

      const skuField = analysis.uniqueFields.find(f => f.path === 'sku');
      expect(skuField?.required).toBe(true);
    });

    it('should skip _id and __v fields', () => {
      const schema = new Schema({
        name: { type: String, index: true },
      });

      const analysis = analyzeSchemaIndexes(schema);

      expect(analysis.indexedFields.map(f => f.path)).not.toContain('_id');
      expect(analysis.indexedFields.map(f => f.path)).not.toContain('__v');
    });

    it('should detect compound indexes', () => {
      const schema = new Schema({
        firstName: { type: String },
        lastName: { type: String },
        email: { type: String },
      });

      schema.index({ firstName: 1, lastName: 1 });
      schema.index({ email: 1, lastName: -1 }, { unique: true });

      const analysis = analyzeSchemaIndexes(schema);

      expect(analysis.compoundIndexes).toHaveLength(2);
      expect(analysis.compoundIndexes[0]?.fields).toEqual({ firstName: 1, lastName: 1 });
      expect(analysis.compoundIndexes[1]?.options.unique).toBe(true);
    });

    it('should handle schema with no indexes', () => {
      const schema = new Schema({
        name: { type: String },
        description: { type: String },
      });

      const analysis = analyzeSchemaIndexes(schema);

      expect(analysis.indexedFields).toHaveLength(0);
      expect(analysis.uniqueFields).toHaveLength(0);
      expect(analysis.compoundIndexes).toHaveLength(0);
    });
  });

  describe('createCleanPayloadSchema', () => {
    it('should remove index property from fields', () => {
      const originalSchema = new Schema({
        name: { type: String, index: true },
        description: { type: String },
      });

      const cleanSchema = createCleanPayloadSchema(originalSchema);
      const namePath = cleanSchema.path('name');

      expect(namePath).toBeDefined();
      expect((namePath?.options as Record<string, unknown>).index).toBeUndefined();
    });

    it('should remove unique property from fields', () => {
      const originalSchema = new Schema({
        sku: { type: String, unique: true, required: true },
      });

      const cleanSchema = createCleanPayloadSchema(originalSchema);
      const skuPath = cleanSchema.path('sku');

      expect(skuPath).toBeDefined();
      expect((skuPath?.options as Record<string, unknown>).unique).toBeUndefined();
      // Required should still be present
      expect((skuPath?.options as Record<string, unknown>).required).toBe(true);
    });

    it('should preserve non-index options', () => {
      const originalSchema = new Schema({
        name: { type: String, index: true, default: 'unknown', trim: true },
      });

      const cleanSchema = createCleanPayloadSchema(originalSchema);
      const namePath = cleanSchema.path('name');

      expect((namePath?.options as Record<string, unknown>).default).toBe('unknown');
      expect((namePath?.options as Record<string, unknown>).trim).toBe(true);
    });

    it('should not include _id in clean schema', () => {
      const originalSchema = new Schema({
        name: { type: String },
      });

      const cleanSchema = createCleanPayloadSchema(originalSchema);

      // The clean schema should have _id: false option
      expect(cleanSchema.get('_id')).toBe(false);
    });
  });

  describe('generateChronicleIndexes', () => {
    it('should generate core chronicle indexes', () => {
      const schema = new Schema({
        name: { type: String },
      });

      const analysis = analyzeSchemaIndexes(schema);
      const indexes = generateChronicleIndexes(analysis, 'test_collection');

      // Should have at least the core indexes
      const indexNames = indexes.map(idx => idx.options.name);
      expect(indexNames).toContain('chronicle_lookup');
      expect(indexNames).toContain('chronicle_time');
      expect(indexNames).toContain('chronicle_latest');
    });

    it('should generate payload indexes for indexed fields', () => {
      const schema = new Schema({
        sku: { type: String, index: true },
        category: { type: String, index: true },
      });

      const analysis = analyzeSchemaIndexes(schema);
      const indexes = generateChronicleIndexes(analysis, 'test_collection');

      const indexNames = indexes.map(idx => idx.options.name);
      expect(indexNames).toContain('chronicle_payload_sku');
      expect(indexNames).toContain('chronicle_payload_category');
    });

    it('should create partial filter expressions for payload indexes', () => {
      const schema = new Schema({
        sku: { type: String, index: true },
      });

      const analysis = analyzeSchemaIndexes(schema);
      const indexes = generateChronicleIndexes(analysis, 'test_collection');

      const skuIndex = indexes.find(idx => idx.options.name === 'chronicle_payload_sku');
      expect(skuIndex?.options.partialFilterExpression).toEqual({
        isLatest: true,
        isDeleted: false,
      });
    });

    it('should include branchId in payload indexes', () => {
      const schema = new Schema({
        sku: { type: String, index: true },
      });

      const analysis = analyzeSchemaIndexes(schema);
      const indexes = generateChronicleIndexes(analysis, 'test_collection');

      const skuIndex = indexes.find(idx => idx.options.name === 'chronicle_payload_sku');
      // Use bracket notation since the key contains a dot
      expect(skuIndex?.spec['payload.sku']).toBe(1);
      expect(skuIndex?.spec.branchId).toBe(1);
    });
  });
});
