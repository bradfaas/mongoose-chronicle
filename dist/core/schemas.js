"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChronicleConfigSchema = exports.ChronicleBranchSchema = exports.ChronicleMetadataSchema = void 0;
exports.createChronicleChunkSchema = createChronicleChunkSchema;
exports.createChronicleKeysSchema = createChronicleKeysSchema;
const mongoose_1 = require("mongoose");
const types_1 = require("../types");
/**
 * Creates the ChronicleChunk schema that wraps original documents
 * @param _payloadSchema - The original document schema to wrap (reserved for future use)
 */
function createChronicleChunkSchema(_payloadSchema) {
    const schema = new mongoose_1.Schema({
        // Unique ChronicleChunk ID (auto-generated)
        _id: {
            type: mongoose_1.Schema.Types.ObjectId,
            default: () => new mongoose_1.Types.ObjectId(),
        },
        // Identifies the unique original document
        docId: {
            type: mongoose_1.Schema.Types.ObjectId,
            required: true,
        },
        // Epoch/generation number - supports document re-creation after deletion
        epoch: {
            type: Number,
            required: true,
            default: 1,
        },
        // Branch this chunk belongs to
        branchId: {
            type: mongoose_1.Schema.Types.ObjectId,
            required: true,
        },
        // Sequential number within the branch
        serial: {
            type: Number,
            required: true,
            default: 1,
        },
        // Chunk type: 1 = full, 2 = delta
        ccType: {
            type: Number,
            required: true,
            enum: [types_1.ChunkType.FULL, types_1.ChunkType.DELTA],
            default: types_1.ChunkType.FULL,
        },
        // Soft delete flag
        isDeleted: {
            type: Boolean,
            required: true,
            default: false,
        },
        // Flag indicating this is the latest chunk for docId+branchId
        // Used for efficient "current state" queries and unique constraint enforcement
        isLatest: {
            type: Boolean,
            required: true,
            default: true,
        },
        // Creation timestamp
        cTime: {
            type: Date,
            required: true,
            default: () => new Date(),
        },
        // The payload - original document data
        payload: {
            type: mongoose_1.Schema.Types.Mixed,
            required: true,
        },
    }, {
        timestamps: false,
        collection: undefined, // Will be set during plugin initialization
    });
    // Core indexes for chronicle operations
    // Primary lookup: find chunks for a document on a branch, ordered by serial (includes epoch)
    schema.index({ docId: 1, epoch: 1, branchId: 1, serial: -1 }, { name: 'chronicle_lookup' });
    // Point-in-time queries
    schema.index({ branchId: 1, cTime: -1 }, { name: 'chronicle_time' });
    // Latest chunk lookup (efficient current state queries)
    schema.index({ docId: 1, epoch: 1, branchId: 1, isLatest: 1 }, { name: 'chronicle_latest', partialFilterExpression: { isLatest: true } });
    // Deleted documents lookup
    schema.index({ docId: 1, isLatest: 1, isDeleted: 1 }, { name: 'chronicle_deleted', partialFilterExpression: { isLatest: true, isDeleted: true } });
    return schema;
}
/**
 * Schema for Chronicle Metadata documents
 * Tracks the active branch and state for each unique document
 */
exports.ChronicleMetadataSchema = new mongoose_1.Schema({
    _id: {
        type: mongoose_1.Schema.Types.ObjectId,
        default: () => new mongoose_1.Types.ObjectId(),
    },
    docId: {
        type: mongoose_1.Schema.Types.ObjectId,
        required: true,
        index: true,
    },
    activeBranchId: {
        type: mongoose_1.Schema.Types.ObjectId,
        required: true,
    },
    epoch: {
        type: Number,
        required: true,
        default: 1,
    },
    metadataStatus: {
        type: String,
        required: true,
        enum: ['pending', 'active', 'orphaned'],
        default: 'pending',
    },
}, {
    timestamps: true,
});
// Compound unique index for docId + epoch (allows multiple epochs per docId)
exports.ChronicleMetadataSchema.index({ docId: 1, epoch: 1 }, { unique: true });
/**
 * Schema for Chronicle Branch documents
 */
exports.ChronicleBranchSchema = new mongoose_1.Schema({
    _id: {
        type: mongoose_1.Schema.Types.ObjectId,
        default: () => new mongoose_1.Types.ObjectId(),
    },
    docId: {
        type: mongoose_1.Schema.Types.ObjectId,
        required: true,
        index: true,
    },
    epoch: {
        type: Number,
        required: true,
        default: 1,
    },
    parentBranchId: {
        type: mongoose_1.Schema.Types.ObjectId,
        default: null,
    },
    parentSerial: {
        type: Number,
        default: null,
    },
    name: {
        type: String,
        required: true,
    },
}, {
    timestamps: { createdAt: true, updatedAt: false },
});
/**
 * Schema for Chronicle Configuration documents
 */
exports.ChronicleConfigSchema = new mongoose_1.Schema({
    _id: {
        type: mongoose_1.Schema.Types.ObjectId,
        default: () => new mongoose_1.Types.ObjectId(),
    },
    collectionName: {
        type: String,
        required: true,
        unique: true,
    },
    fullChunkInterval: {
        type: Number,
        required: true,
        default: 10,
    },
    pluginVersion: {
        type: String,
        required: true,
    },
    // Store the analyzed index information for this collection
    indexedFields: {
        type: [String],
        default: [],
    },
    uniqueFields: {
        type: [String],
        default: [],
    },
}, {
    timestamps: true,
});
/**
 * Schema for Chronicle Keys collection
 * Maintains current unique key values for fast uniqueness checks
 * One document per unique docId+branchId combination
 */
function createChronicleKeysSchema(uniqueFields) {
    // Build schema definition dynamically
    const schemaDefinition = {
        _id: {
            type: mongoose_1.Schema.Types.ObjectId,
            default: () => new mongoose_1.Types.ObjectId(),
        },
        // Reference to the document
        docId: {
            type: mongoose_1.Schema.Types.ObjectId,
            required: true,
        },
        // Branch this key entry belongs to
        branchId: {
            type: mongoose_1.Schema.Types.ObjectId,
            required: true,
        },
        // Whether the document is deleted (keys are kept for history but marked)
        isDeleted: {
            type: Boolean,
            required: true,
            default: false,
        },
    };
    // Add each unique field to the schema
    for (const field of uniqueFields) {
        schemaDefinition[`key_${field}`] = {
            type: mongoose_1.Schema.Types.Mixed,
            required: false, // Allow null for optional unique fields
        };
    }
    const schema = new mongoose_1.Schema(schemaDefinition, {
        timestamps: true,
    });
    // Compound unique index for docId + branchId
    schema.index({ docId: 1, branchId: 1 }, { unique: true, name: 'chronicle_keys_doc_branch' });
    // Create unique indexes for each unique field (per branch, excluding deleted)
    for (const field of uniqueFields) {
        schema.index({ [`key_${field}`]: 1, branchId: 1 }, {
            unique: true,
            sparse: true, // Allow multiple nulls
            partialFilterExpression: { isDeleted: false, [`key_${field}`]: { $exists: true, $ne: null } },
            name: `chronicle_keys_unique_${field}`,
        });
    }
    return schema;
}
// Compound indexes for efficient queries
exports.ChronicleMetadataSchema.index({ docId: 1, metadataStatus: 1 });
exports.ChronicleBranchSchema.index({ docId: 1, name: 1 });
//# sourceMappingURL=schemas.js.map