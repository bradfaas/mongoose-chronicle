import { Schema, Types, Connection } from 'mongoose';
import type {
  ChroniclePluginOptions,
  ChronicleChunk,
  ChronicleBranch,
} from '../types';
import {
  ChronicleMetadataSchema,
  ChronicleBranchSchema,
  ChronicleConfigSchema,
} from './schemas';

const PLUGIN_VERSION = '1.0.0';
const DEFAULT_FULL_CHUNK_INTERVAL = 10;
const DEFAULT_CONFIG_COLLECTION = 'chronicle_config';

/**
 * The main mongoose-chronicle plugin function
 * Transforms a standard Mongoose schema to use ChronicleChunk document storage
 */
export function chroniclePlugin(
  schema: Schema,
  options: ChroniclePluginOptions = {}
): void {
  const {
    primaryKey = '_id',
    fullChunkInterval = DEFAULT_FULL_CHUNK_INTERVAL,
    configCollectionName = DEFAULT_CONFIG_COLLECTION,
  } = options;

  // Store plugin options on schema for later access
  (schema as Schema & { chronicleOptions: ChroniclePluginOptions }).chronicleOptions = {
    primaryKey,
    fullChunkInterval,
    configCollectionName,
    ...options,
  };

  // Add chronicle-specific instance methods
  addInstanceMethods(schema);

  // Add chronicle-specific static methods
  addStaticMethods(schema);

  // Override middleware for CRUD operations
  addMiddleware(schema);
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
function addStaticMethods(schema: Schema): void {
  schema.statics.findAsOf = async function(
    _filter: Record<string, unknown>,
    _asOf: Date
  ): Promise<unknown> {
    // Implementation will rehydrate document state at given time
    // TODO: Implement point-in-time query
    return null;
  };

  schema.statics.createBranch = async function(
    _docId: Types.ObjectId,
    _branchName: string
  ): Promise<ChronicleBranch> {
    // Implementation will create a new branch
    // TODO: Implement branch creation
    throw new Error('Not implemented');
  };

  schema.statics.switchBranch = async function(
    _docId: Types.ObjectId,
    _branchId: Types.ObjectId
  ): Promise<void> {
    // Implementation will switch active branch
    // TODO: Implement branch switching
    throw new Error('Not implemented');
  };

  schema.statics.listBranches = async function(
    _docId: Types.ObjectId
  ): Promise<ChronicleBranch[]> {
    // Implementation will list all branches
    // TODO: Implement branch listing
    return [];
  };
}

/**
 * Adds middleware hooks to intercept CRUD operations
 */
function addMiddleware(schema: Schema): void {
  // Pre-save hook for create and update operations
  schema.pre('save', async function(next) {
    // TODO: Implement save interception
    // - For new documents: create metadata, branch, and full chunk
    // - For existing documents: create delta or full chunk
    next();
  });

  // Pre-find hooks to rehydrate documents
  schema.pre('find', function() {
    // TODO: Implement query rewriting for find operations
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
  options: ChroniclePluginOptions = {}
): Promise<void> {
  const {
    fullChunkInterval = DEFAULT_FULL_CHUNK_INTERVAL,
    configCollectionName = DEFAULT_CONFIG_COLLECTION,
    metadataCollectionName = `${collectionName}_chronicle_metadata`,
  } = options;

  // Ensure config collection exists and has entry for this collection
  const ConfigModel = connection.model(
    'ChronicleConfig',
    ChronicleConfigSchema,
    configCollectionName
  );

  await ConfigModel.findOneAndUpdate(
    { collectionName },
    {
      collectionName,
      fullChunkInterval,
      pluginVersion: PLUGIN_VERSION,
    },
    { upsert: true, new: true }
  );

  // Ensure metadata collection exists
  if (!connection.models['ChronicleMetadata_' + collectionName]) {
    connection.model(
      'ChronicleMetadata_' + collectionName,
      ChronicleMetadataSchema,
      metadataCollectionName
    );
  }

  // Ensure branch collection exists
  const branchCollectionName = `${collectionName}_chronicle_branches`;
  if (!connection.models['ChronicleBranch_' + collectionName]) {
    connection.model(
      'ChronicleBranch_' + collectionName,
      ChronicleBranchSchema,
      branchCollectionName
    );
  }
}

export default chroniclePlugin;
