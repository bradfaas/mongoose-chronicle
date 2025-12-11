"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeSchemaIndexes = analyzeSchemaIndexes;
exports.createCleanPayloadSchema = createCleanPayloadSchema;
exports.generateChronicleIndexes = generateChronicleIndexes;
const mongoose_1 = require("mongoose");
/**
 * Analyzes a Mongoose schema to extract index and unique key information
 * @param schema - The Mongoose schema to analyze
 * @returns Analysis results with indexed and unique fields
 */
function analyzeSchemaIndexes(schema) {
    const indexedFields = [];
    const uniqueFields = [];
    const compoundIndexes = [];
    // Analyze each path in the schema
    schema.eachPath((path, schemaType) => {
        // Skip internal mongoose fields
        if (path === '_id' || path === '__v') {
            return;
        }
        const options = schemaType.options;
        const fieldInfo = {
            path,
            indexed: Boolean(options.index),
            unique: Boolean(options.unique),
            required: Boolean(options.required),
            sparse: Boolean(options.sparse),
        };
        if (fieldInfo.indexed || fieldInfo.unique) {
            indexedFields.push(fieldInfo);
        }
        if (fieldInfo.unique) {
            uniqueFields.push(fieldInfo);
        }
    });
    // Extract compound indexes from schema.indexes()
    const schemaIndexes = schema.indexes();
    for (const [indexSpec, indexOptions] of schemaIndexes) {
        // Skip single-field indexes (already captured above)
        const fieldCount = Object.keys(indexSpec).length;
        if (fieldCount > 1) {
            compoundIndexes.push({
                fields: indexSpec,
                options: {
                    unique: Boolean(indexOptions?.unique),
                    sparse: Boolean(indexOptions?.sparse),
                    name: indexOptions?.name,
                },
            });
        }
    }
    return {
        indexedFields,
        uniqueFields,
        compoundIndexes,
    };
}
/**
 * Creates a "clean" version of a schema with indexes and unique constraints removed
 * This is used for the payload field in ChronicleChunk
 * @param schema - The original schema
 * @returns A new schema without index/unique constraints
 */
function createCleanPayloadSchema(schema) {
    const cleanDefinition = {};
    schema.eachPath((path, schemaType) => {
        // Skip internal mongoose fields
        if (path === '_id' || path === '__v') {
            return;
        }
        // Clone the schema type options without index-related properties
        const originalOptions = schemaType.options;
        const cleanOptions = { ...originalOptions };
        // Remove index-related properties
        delete cleanOptions.index;
        delete cleanOptions.unique;
        delete cleanOptions.sparse;
        cleanDefinition[path] = cleanOptions;
    });
    return new mongoose_1.Schema(cleanDefinition, { _id: false, versionKey: false });
}
/**
 * Generates the index definitions needed for the ChronicleChunk collection
 * @param analysis - The schema analysis result
 * @param collectionName - Name of the original collection (for naming)
 * @returns Array of index specifications to create
 */
function generateChronicleIndexes(analysis, _collectionName) {
    const indexes = [];
    // Core indexes for chronicle operations
    // 1. Primary lookup index: find chunks for a document on a branch
    indexes.push({
        spec: { docId: 1, branchId: 1, serial: -1 },
        options: { name: 'chronicle_lookup' },
    });
    // 2. Point-in-time query index
    indexes.push({
        spec: { branchId: 1, cTime: -1 },
        options: { name: 'chronicle_time' },
    });
    // 3. Latest chunk lookup (for efficient current state queries)
    indexes.push({
        spec: { docId: 1, branchId: 1, isLatest: 1 },
        options: {
            name: 'chronicle_latest',
            partialFilterExpression: { isLatest: true },
        },
    });
    // 4. Create query indexes for originally indexed fields (on payload)
    for (const field of analysis.indexedFields) {
        // Don't create unique indexes on payload - we handle uniqueness separately
        indexes.push({
            spec: { [`payload.${field.path}`]: 1, branchId: 1, isDeleted: 1, isLatest: 1 },
            options: {
                name: `chronicle_payload_${field.path}`,
                partialFilterExpression: { isLatest: true, isDeleted: false },
            },
        });
    }
    return indexes;
}
//# sourceMappingURL=schema-analyzer.js.map