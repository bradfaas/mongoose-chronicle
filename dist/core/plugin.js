"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChronicleUniqueConstraintError = void 0;
exports.chroniclePlugin = chroniclePlugin;
exports.getChronicleAnalysis = getChronicleAnalysis;
exports.getChronicleOptions = getChronicleOptions;
exports.initializeChronicle = initializeChronicle;
const schemas_1 = require("./schemas");
const schema_analyzer_1 = require("../utils/schema-analyzer");
const chronicle_operations_1 = require("./chronicle-operations");
const PLUGIN_VERSION = '1.0.0';
const DEFAULT_FULL_CHUNK_INTERVAL = 10;
const DEFAULT_CONFIG_COLLECTION = 'chronicle_config';
/** Symbol to store chronicle analysis on the schema */
const CHRONICLE_ANALYSIS = Symbol('chronicleAnalysis');
/** Symbol to store chronicle context on documents */
const CHRONICLE_DOC_ID = Symbol('chronicleDocId');
/**
 * The main mongoose-chronicle plugin function
 * Transforms a standard Mongoose schema to use ChronicleChunk document storage
 */
function chroniclePlugin(schema, options = {}) {
    const chronicleSchema = schema;
    const { primaryKey = '_id', fullChunkInterval = DEFAULT_FULL_CHUNK_INTERVAL, configCollectionName = DEFAULT_CONFIG_COLLECTION, } = options;
    // Analyze the original schema for indexes and unique constraints
    const analysis = (0, schema_analyzer_1.analyzeSchemaIndexes)(schema);
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
    // Add __chronicle_deleted field for transparent soft delete filtering
    schema.add({
        __chronicle_deleted: {
            type: Boolean,
            default: false,
            index: true,
        },
    });
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
function getChronicleAnalysis(schema) {
    return schema[CHRONICLE_ANALYSIS];
}
/**
 * Gets the chronicle options for a schema
 */
function getChronicleOptions(schema) {
    return schema.chronicleOptions;
}
/**
 * Adds instance methods to documents
 */
function addInstanceMethods(schema) {
    schema.methods.getHistory = async function () {
        // Implementation will query all chunks for this document
        // TODO: Implement full history retrieval
        return [];
    };
    schema.methods.createSnapshot = async function (_name) {
        // Implementation will create a new branch at current state
        // TODO: Implement snapshot creation
        throw new Error('Not implemented');
    };
    schema.methods.getBranches = async function () {
        // Implementation will return all branches for this document
        // TODO: Implement branch listing
        return [];
    };
}
/**
 * Adds static methods to the model
 */
function addStaticMethods(schema, options) {
    schema.statics.findAsOf = async function (_filter, _asOf) {
        // Implementation will rehydrate document state at given time
        // TODO: Implement point-in-time query
        return null;
    };
    schema.statics.createBranch = async function (docId, branchName, branchOptions = {}) {
        const connection = this.db;
        const baseCollectionName = this.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        return (0, chronicle_operations_1.createBranch)(ctx, docId, branchName, branchOptions);
    };
    schema.statics.switchBranch = async function (docId, branchId) {
        const connection = this.db;
        const baseCollectionName = this.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        return (0, chronicle_operations_1.switchBranch)(ctx, docId, branchId);
    };
    schema.statics.listBranches = async function (docId) {
        const connection = this.db;
        const baseCollectionName = this.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        return (0, chronicle_operations_1.listBranches)(ctx, docId);
    };
    schema.statics.getActiveBranch = async function (docId) {
        const connection = this.db;
        const baseCollectionName = this.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        return (0, chronicle_operations_1.getActiveBranch)(ctx, docId);
    };
    schema.statics.chronicleRevert = async function (docId, serial, revertOptions = {}) {
        const connection = this.db;
        const baseCollectionName = this.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        return (0, chronicle_operations_1.chronicleRevert)(ctx, docId, serial, revertOptions);
    };
    schema.statics.chronicleSquash = async function (docId, serial, squashOptions) {
        const connection = this.db;
        const baseCollectionName = this.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        return (0, chronicle_operations_1.chronicleSquash)(ctx, docId, serial, squashOptions);
    };
    schema.statics.chronicleAsOf = async function (docId, asOf, asOfOptions = {}) {
        const connection = this.db;
        const baseCollectionName = this.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        return (0, chronicle_operations_1.chronicleAsOf)(ctx, docId, asOf, asOfOptions);
    };
    schema.statics.chronicleSoftDelete = async function (docId) {
        const connection = this.db;
        const baseCollectionName = this.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        return (0, chronicle_operations_1.chronicleSoftDelete)(ctx, docId);
    };
    schema.statics.chronicleUndelete = async function (docId, undeleteOptions = {}) {
        const connection = this.db;
        const baseCollectionName = this.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        return (0, chronicle_operations_1.chronicleUndelete)(ctx, docId, undeleteOptions);
    };
    schema.statics.chronicleListDeleted = async function (filters = {}) {
        const connection = this.db;
        const baseCollectionName = this.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        return (0, chronicle_operations_1.chronicleListDeleted)(ctx, filters);
    };
    schema.statics.chroniclePurge = async function (docId, purgeOptions) {
        const connection = this.db;
        const baseCollectionName = this.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        return (0, chronicle_operations_1.chroniclePurge)(ctx, docId, purgeOptions);
    };
}
/**
 * Creates a chronicle context for operations
 */
function createChronicleContext(connection, baseCollectionName, chunksCollectionName, options) {
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
function addMiddleware(schema, options) {
    // Pre-save hook for create and update operations
    // Note: Mongoose 9.x async middleware should not use next() - just return or throw
    schema.pre('save', async function () {
        const doc = this;
        const connection = doc.db;
        // Use the original collection name for chronicle chunks
        const baseCollectionName = doc.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        // Create chronicle context with both collection names
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        try {
            // Process the save through chronicle
            const result = await (0, chronicle_operations_1.processChroniclesSave)(ctx, doc, doc.isNew);
            // Store the chronicle docId on the document for reference
            doc[CHRONICLE_DOC_ID] = result.docId;
            // Mongoose 9.x: async middleware continues automatically, no need to call next()
        }
        catch (error) {
            if (error instanceof chronicle_operations_1.ChronicleUniqueConstraintError) {
                // Convert to a mongoose-style error
                const mongooseError = new Error(error.message);
                mongooseError.name = 'MongoServerError';
                mongooseError.code = 11000; // Duplicate key error code
                throw mongooseError;
            }
            throw error;
        }
    });
    // Pre-find hooks to filter out deleted documents
    schema.pre('find', function () {
        const queryOptions = this.getOptions();
        if (queryOptions.includeDeleted !== true) {
            this.where('__chronicle_deleted').ne(true);
        }
    });
    schema.pre('findOne', function () {
        const queryOptions = this.getOptions();
        if (queryOptions.includeDeleted !== true) {
            this.where('__chronicle_deleted').ne(true);
        }
    });
    schema.pre('findOneAndUpdate', async function () {
        // TODO: Implement findOneAndUpdate interception
    });
    // Transparent soft delete via findOneAndDelete / findByIdAndDelete
    schema.pre('findOneAndDelete', async function () {
        const filter = this.getFilter();
        const Model = this.model;
        const connection = Model.db;
        const baseCollectionName = Model.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        // Find the document to be deleted (include deleted to get accurate state)
        const doc = await Model.findOne(filter, null, { includeDeleted: true }).select('_id __chronicle_deleted');
        if (!doc || doc.__chronicle_deleted === true) {
            // Nothing to delete or already deleted - make query match nothing
            this.setQuery({ _id: null });
            return;
        }
        // Create deletion chunk via chronicle
        await (0, chronicle_operations_1.chronicleSoftDelete)(ctx, doc._id);
        // Mark as deleted in main collection (instead of actually deleting)
        await Model.updateOne({ _id: doc._id }, { $set: { __chronicle_deleted: true } });
        // Prevent actual deletion by making query match nothing
        this.setQuery({ _id: null });
    });
    // Transparent soft delete via deleteOne (query middleware)
    schema.pre('deleteOne', { document: false, query: true }, async function () {
        const filter = this.getFilter();
        const Model = this.model;
        const connection = Model.db;
        const baseCollectionName = Model.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        // Find the document to be deleted
        const doc = await Model.findOne(filter, null, { includeDeleted: true }).select('_id __chronicle_deleted');
        if (!doc || doc.__chronicle_deleted === true) {
            // Nothing to delete or already deleted
            this.setQuery({ _id: null });
            return;
        }
        // Create deletion chunk via chronicle
        await (0, chronicle_operations_1.chronicleSoftDelete)(ctx, doc._id);
        // Mark as deleted in main collection
        await Model.updateOne({ _id: doc._id }, { $set: { __chronicle_deleted: true } });
        // Prevent actual deletion
        this.setQuery({ _id: null });
    });
    // Transparent soft delete via deleteMany with safety limit
    const DELETE_MANY_LIMIT = options.deleteManyLimit ?? 100;
    schema.pre('deleteMany', async function () {
        const filter = this.getFilter();
        const queryOptions = this.getOptions();
        const Model = this.model;
        const connection = Model.db;
        const baseCollectionName = Model.collection.name;
        const chunksCollectionName = `${baseCollectionName}_chronicle_chunks`;
        const ctx = createChronicleContext(connection, baseCollectionName, chunksCollectionName, options);
        // Count matching non-deleted documents
        const count = await Model.countDocuments({ ...filter, __chronicle_deleted: { $ne: true } });
        if (count === 0) {
            // Nothing to delete
            this.setQuery({ _id: null });
            return;
        }
        // Safety check unless bypassed
        if (count > DELETE_MANY_LIMIT && queryOptions.chronicleForceDeleteMany !== true) {
            throw new Error(`deleteMany would affect ${count} documents, exceeding limit of ${DELETE_MANY_LIMIT}. Use { chronicleForceDeleteMany: true } to bypass.`);
        }
        // Get all matching non-deleted documents
        const docs = await Model.find({ ...filter, __chronicle_deleted: { $ne: true } }, null, { includeDeleted: true }).select('_id');
        // Soft delete each document
        for (const doc of docs) {
            try {
                await (0, chronicle_operations_1.chronicleSoftDelete)(ctx, doc._id);
            }
            catch (error) {
                // Skip already-deleted documents
                if (!error.message?.includes('already deleted')) {
                    throw error;
                }
            }
        }
        // Mark all as deleted in main collection
        await Model.updateMany(filter, { $set: { __chronicle_deleted: true } });
        // Prevent actual deletion
        this.setQuery({ _id: null });
    });
    // Add query helper for including deleted documents
    schema.query.includeDeleted = function () {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return this.setOptions({ includeDeleted: true });
    };
    // Post-find hooks to transform results
    schema.post('find', function (_docs) {
        // TODO: Implement document rehydration
    });
    schema.post('findOne', function (_doc) {
        // TODO: Implement document rehydration
    });
}
/**
 * Initializes chronicle collections and configuration
 * Should be called once per collection when the model is created
 */
async function initializeChronicle(connection, collectionName, options = {}, schemaAnalysis) {
    const { fullChunkInterval = DEFAULT_FULL_CHUNK_INTERVAL, configCollectionName = DEFAULT_CONFIG_COLLECTION, metadataCollectionName = `${collectionName}_chronicle_metadata`, indexes = [], uniqueKeys = [], } = options;
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
    await configCollection.updateOne({ collectionName }, {
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
    }, { upsert: true });
    // Ensure metadata collection exists
    const metadataModelName = `ChronicleMetadata_${collectionName}`;
    if (!connection.models[metadataModelName]) {
        connection.model(metadataModelName, schemas_1.ChronicleMetadataSchema, metadataCollectionName);
    }
    // Ensure branch collection exists
    const branchCollectionName = `${collectionName}_chronicle_branches`;
    const branchModelName = `ChronicleBranch_${collectionName}`;
    if (!connection.models[branchModelName]) {
        connection.model(branchModelName, schemas_1.ChronicleBranchSchema, branchCollectionName);
    }
    // Create the keys collection if there are unique fields
    if (uniqueFields.length > 0) {
        const keysCollectionName = `${collectionName}_chronicle_keys`;
        const keysModelName = `ChronicleKeys_${collectionName}`;
        if (!connection.models[keysModelName]) {
            const keysSchema = (0, schemas_1.createChronicleKeysSchema)(uniqueFields);
            connection.model(keysModelName, keysSchema, keysCollectionName);
        }
    }
    // Create optimized indexes on the main collection for payload fields
    if (schemaAnalysis && indexedFields.length > 0) {
        const chronicleIndexes = (0, schema_analyzer_1.generateChronicleIndexes)(schemaAnalysis, collectionName);
        // Create indexes on the chronicle chunks collection (same as original collection name)
        const chunksCollection = connection.db.collection(collectionName);
        for (const idx of chronicleIndexes) {
            try {
                await chunksCollection.createIndex(idx.spec, idx.options);
            }
            catch (error) {
                // Index might already exist, which is fine
                const err = error;
                if (!err.message?.includes('already exists')) {
                    console.warn(`Warning: Could not create index ${idx.options.name}: ${err.message}`);
                }
            }
        }
    }
}
// Re-export for convenience
var chronicle_operations_2 = require("./chronicle-operations");
Object.defineProperty(exports, "ChronicleUniqueConstraintError", { enumerable: true, get: function () { return chronicle_operations_2.ChronicleUniqueConstraintError; } });
exports.default = chroniclePlugin;
//# sourceMappingURL=plugin.js.map