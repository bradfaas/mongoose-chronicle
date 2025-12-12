import type { Types, Schema, Connection, Document } from 'mongoose';
import type {
  ChroniclePluginOptions,
  ChronicleChunk,
  ChronicleBranch,
} from '../types';
import {
  ChronicleMetadataSchema,
  ChronicleBranchSchema,
  createChronicleKeysSchema,
} from './schemas';
import {
  analyzeSchemaIndexes,
  generateChronicleIndexes,
  type SchemaIndexAnalysis,
} from '../utils/schema-analyzer';
import {
  processChroniclesSave,
  createBranch as createBranchOp,
  switchBranch as switchBranchOp,
  listBranches as listBranchesOp,
  getActiveBranch as getActiveBranchOp,
  chronicleRevert as chronicleRevertOp,
  chronicleSquash as chronicleSquashOp,
  type ChronicleContext,
  ChronicleUniqueConstraintError,
} from './chronicle-operations';
import type {
  CreateBranchOptions,
  RevertOptions,
  RevertResult,
  SquashOptions,
  SquashResult,
  SquashDryRunResult,
} from '../types';

const PLUGIN_VERSION = '1.0.0';
const DEFAULT_FULL_CHUNK_INTERVAL = 10;
const DEFAULT_CONFIG_COLLECTION = 'chronicle_config';

/** Symbol to store chronicle analysis on the schema */
const CHRONICLE_ANALYSIS = Symbol('chronicleAnalysis');

/** Symbol to store chronicle context on documents */
const CHRONICLE_DOC_ID = Symbol('chronicleDocId');

/** Extended schema type with chronicle data */
interface ChronicleSchema extends Schema {
  chronicleOptions?: ChroniclePluginOptions;
  [CHRONICLE_ANALYSIS]?: SchemaIndexAnalysis;
}

/** Extended document type with chronicle data */
interface ChronicleEnabledDocument extends Document {
  [CHRONICLE_DOC_ID]?: Types.ObjectId;
}

/**
 * The main mongoose-chronicle plugin function
 * Transforms a standard Mongoose schema to use ChronicleChunk document storage
 */
export function chroniclePlugin(
  schema: Schema,
  options: ChroniclePluginOptions = {}
): void {
  const chronicleSchema = schema as ChronicleSchema;

  const {
    primaryKey = '_id',
    fullChunkInterval = DEFAULT_FULL_CHUNK_INTERVAL,
    configCollectionName = DEFAULT_CONFIG_COLLECTION,
  } = options;

  // Analyze the original schema for indexes and unique constraints
  const analysis = analyzeSchemaIndexes(schema);

  // Store plugin options and analysis on schema for later access
  chronicleSchema.chronicleOptions = {
    primaryKey,
    fullChunkInterval,
    configCollectionName,
    // Override with analyzed values if not provided in options
    indexes: options.indexes ?? analysis.indexedFields.map(f => f.path),
    uniqueKeys: options.uniqueKeys ?? analysis.uniqueFields.map(f => f.path),
    ...options,
  };

  chronicleSchema[CHRONICLE_ANALYSIS] = analysis;

  // Add chronicle-specific instance methods
  addInstanceMethods(schema);

  // Add chronicle-specific static methods
  addStaticMethods(schema, chronicleSchema.chronicleOptions);

  // Override middleware for CRUD operations
  addMiddleware(schema, chronicleSchema.chronicleOptions);
}

/**
 * Gets the chronicle analysis for a schema
 */
export function getChronicleAnalysis(schema: Schema): SchemaIndexAnalysis | undefined {
  return (schema as ChronicleSchema)[CHRONICLE_ANALYSIS];
}

/**
 * Gets the chronicle options for a schema
 */
export function getChronicleOptions(schema: Schema): ChroniclePluginOptions | undefined {
  return (schema as ChronicleSchema).chronicleOptions;
}

/**
 * Adds instance methods to documents
 */
function addInstanceMethods(schema: Schema): void {
  schema.methods.getHistory = async function(): Promise<ChronicleChunk[]> {
    // Implementation will query all chunks for this document
    // TODO: Implement full history retrieval
    return [];
  };

  schema.methods.createSnapshot = async function(_name: string): Promise<ChronicleBranch> {
    // Implementation will create a new branch at current state
    // TODO: Implement snapshot creation
    throw new Error('Not implemented');
  };

  schema.methods.getBranches = async function(): Promise<ChronicleBranch[]> {
    // Implementation will return all branches for this document
    // TODO: Implement branch listing
    return [];
  };
}

/**
 * Adds static methods to the model
 */
function addStaticMethods(schema: Schema, options: ChroniclePluginOptions): void {
  schema.statics.findAsOf = async function(
    _filter: Record<string, unknown>,
    _asOf: Date
  ): Promise<unknown> {
    // Implementation will rehydrate document state at given time
    // TODO: Implement point-in-time query
    return null;
  };

  schema.statics.createBranch = async function(
    docId: Types.ObjectId,
    branchName: string,
    branchOptions: CreateBranchOptions = {}
  ): Promise<ChronicleBranch> {
    const connection = this.db;
    const baseCollectionName = this.collection.name;
    const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
    const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
    return createBranchOp(ctx, docId, branchName, branchOptions);
  };

  schema.statics.switchBranch = async function(
    docId: Types.ObjectId,
    branchId: Types.ObjectId
  ): Promise<void> {
    const connection = this.db;
    const baseCollectionName = this.collection.name;
    const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
    const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
    return switchBranchOp(ctx, docId, branchId);
  };

  schema.statics.listBranches = async function(
    docId: Types.ObjectId
  ): Promise<ChronicleBranch[]> {
    const connection = this.db;
    const baseCollectionName = this.collection.name;
    const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
    const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
    return listBranchesOp(ctx, docId);
  };

  schema.statics.getActiveBranch = async function(
    docId: Types.ObjectId
  ): Promise<ChronicleBranch | null> {
    const connection = this.db;
    const baseCollectionName = this.collection.name;
    const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
    const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
    return getActiveBranchOp(ctx, docId);
  };

  schema.statics.chronicleRevert = async function(
    docId: Types.ObjectId,
    serial: number,
    revertOptions: RevertOptions = {}
  ): Promise<RevertResult> {
    const connection = this.db;
    const baseCollectionName = this.collection.name;
    const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
    const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
    return chronicleRevertOp(ctx, docId, serial, revertOptions);
  };

  schema.statics.chronicleSquash = async function(
    docId: Types.ObjectId,
    serial: number,
    squashOptions: SquashOptions
  ): Promise<SquashResult | SquashDryRunResult> {
    const connection = this.db;
    const baseCollectionName = this.collection.name;
    const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
    const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
    return chronicleSquashOp(ctx, docId, serial, squashOptions);
  };
}

/**
 * Creates a chronicle context for operations
 */
function createChronicleContext(
  connection: Connection,
  baseCollectionName: string,
  chunksCollectionName: string,
  options: ChroniclePluginOptions
): ChronicleContext {
  return {
    connection,
    baseCollectionName,
    chunksCollectionName,
    options,
    uniqueFields: options.uniqueKeys ?? [],
    indexedFields: options.indexes ?? [],
  };
}

/**
 * Adds middleware hooks to intercept CRUD operations
 */
function addMiddleware(schema: Schema, options: ChroniclePluginOptions): void {
  // Pre-save hook for create and update operations
  // Note: Mongoose 9.x async middleware should not use next() - just return or throw
  schema.pre('save', async function() {
    const doc = this as ChronicleEnabledDocument;
    const connection = doc.db;
    // Use the original collection name for chronicle chunks
    const baseCollectionName = doc.collection.name;
    const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;

    // Create chronicle context with both collection names
    const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);

    try {
      // Process the save through chronicle
      const result = await processChroniclesSave(ctx, doc, doc.isNew);

      // Store the chronicle docId on the document for reference
      doc[CHRONICLE_DOC_ID] = result.docId;

      // Mongoose 9.x: async middleware continues automatically, no need to call next()
    } catch (error) {
      if (error instanceof ChronicleUniqueConstraintError) {
        // Convert to a mongoose-style error
        const mongooseError = new Error(error.message) as Error & { code: number };
        mongooseError.name = 'MongoServerError';
        mongooseError.code = 11000; // Duplicate key error code
        throw mongooseError;
      }
      throw error;
    }
  });

  // Pre-find hooks to rehydrate documents
  schema.pre('find', function() {
    // TODO: Implement query rewriting for find operations
    // For now, queries work on raw chronicle data
  });

  schema.pre('findOne', function() {
    // TODO: Implement query rewriting for findOne operations
  });

  schema.pre('findOneAndUpdate', async function() {
    // TODO: Implement findOneAndUpdate interception
  });

  schema.pre('findOneAndDelete', async function() {
    // TODO: Implement soft delete via isDeleted flag
  });

  // Post-find hooks to transform results
  schema.post('find', function(_docs) {
    // TODO: Implement document rehydration
  });

  schema.post('findOne', function(_doc) {
    // TODO: Implement document rehydration
  });
}

/**
 * Initializes chronicle collections and configuration
 * Should be called once per collection when the model is created
 */
export async function initializeChronicle(
  connection: Connection,
  collectionName: string,
  options: ChroniclePluginOptions = {},
  schemaAnalysis?: SchemaIndexAnalysis
): Promise<void> {
  const {
    fullChunkInterval = DEFAULT_FULL_CHUNK_INTERVAL,
    configCollectionName = DEFAULT_CONFIG_COLLECTION,
    metadataCollectionName = `${collectionName}_chronicle_metadata`,
    indexes = [],
    uniqueKeys = [],
  } = options;

  // Get or create the config model - use native MongoDB driver for simplicity
  if (!connection.db) {
    throw new Error('Database connection not established. Ensure mongoose is connected before calling initializeChronicle.');
  }

  // Determine indexed and unique fields
  const indexedFields = schemaAnalysis
    ? schemaAnalysis.indexedFields.map(f => f.path)
    : indexes;
  const uniqueFields = schemaAnalysis
    ? schemaAnalysis.uniqueFields.map(f => f.path)
    : uniqueKeys;

  const configCollection = connection.db.collection(configCollectionName);

  await configCollection.updateOne(
    { collectionName },
    {
      $set: {
        collectionName,
        fullChunkInterval,
        pluginVersion: PLUGIN_VERSION,
        indexedFields,
        uniqueFields,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );

  // Ensure metadata collection exists
  const metadataModelName = `ChronicleMetadata_${collectionName}`;
  if (!connection.models[metadataModelName]) {
    connection.model(metadataModelName, ChronicleMetadataSchema, metadataCollectionName);
  }

  // Ensure branch collection exists
  const branchCollectionName = `${collectionName}_chronicle_branches`;
  const branchModelName = `ChronicleBranch_${collectionName}`;
  if (!connection.models[branchModelName]) {
    connection.model(branchModelName, ChronicleBranchSchema, branchCollectionName);
  }

  // Create the keys collection if there are unique fields
  if (uniqueFields.length > 0) {
    const keysCollectionName = `${collectionName}_chronicle_keys`;
    const keysModelName = `ChronicleKeys_${collectionName}`;
    if (!connection.models[keysModelName]) {
      const keysSchema = createChronicleKeysSchema(uniqueFields);
      connection.model(keysModelName, keysSchema, keysCollectionName);
    }
  }

  // Create optimized indexes on the main collection for payload fields
  if (schemaAnalysis && indexedFields.length > 0) {
    const chronicleIndexes = generateChronicleIndexes(schemaAnalysis, collectionName);

    // Create indexes on the chronicle chunks collection (same as original collection name)
    const chunksCollection = connection.db.collection(collectionName);

    for (const idx of chronicleIndexes) {
      try {
        await chunksCollection.createIndex(idx.spec, idx.options);
      } catch (error) {
        // Index might already exist, which is fine
        const err = error as Error;
        if (!err.message?.includes('already exists')) {
          console.warn(`Warning: Could not create index ${idx.options.name}: ${err.message}`);
        }
      }
    }
  }
}

// Re-export for convenience
export { ChronicleUniqueConstraintError } from './chronicle-operations';

export default chroniclePlugin;
