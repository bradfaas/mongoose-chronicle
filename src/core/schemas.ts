import { Schema, Types } from 'mongoose';
import { ChunkType } from '../types';

/**
 * Creates the ChronicleChunk schema that wraps original documents
 * @param _payloadSchema - The original document schema to wrap (reserved for future use)
 */
export function createChronicleChunkSchema(_payloadSchema?: Schema): Schema {
  const schema = new Schema({
    // Unique ChronicleChunk ID (auto-generated)
    _id: {
      type: Schema.Types.ObjectId,
      default: () => new Types.ObjectId(),
    },
    // Identifies the unique original document
    docId: {
      type: Schema.Types.ObjectId,
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
      type: Schema.Types.ObjectId,
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
      enum: [ChunkType.FULL, ChunkType.DELTA],
      default: ChunkType.FULL,
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
      type: Schema.Types.Mixed,
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
  schema.index(
    { docId: 1, epoch: 1, branchId: 1, isLatest: 1 },
    { name: 'chronicle_latest', partialFilterExpression: { isLatest: true } }
  );

  // Deleted documents lookup
  schema.index(
    { docId: 1, isLatest: 1, isDeleted: 1 },
    { name: 'chronicle_deleted', partialFilterExpression: { isLatest: true, isDeleted: true } }
  );

  return schema;
}

/**
 * Schema for Chronicle Metadata documents
 * Tracks the active branch and state for each unique document
 */
export const ChronicleMetadataSchema = new Schema({
  _id: {
    type: Schema.Types.ObjectId,
    default: () => new Types.ObjectId(),
  },
  docId: {
    type: Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  activeBranchId: {
    type: Schema.Types.ObjectId,
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
ChronicleMetadataSchema.index({ docId: 1, epoch: 1 }, { unique: true });

/**
 * Schema for Chronicle Branch documents
 */
export const ChronicleBranchSchema = new Schema({
  _id: {
    type: Schema.Types.ObjectId,
    default: () => new Types.ObjectId(),
  },
  docId: {
    type: Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  epoch: {
    type: Number,
    required: true,
    default: 1,
  },
  parentBranchId: {
    type: Schema.Types.ObjectId,
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
export const ChronicleConfigSchema = new Schema({
  _id: {
    type: Schema.Types.ObjectId,
    default: () => new Types.ObjectId(),
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
export function createChronicleKeysSchema(uniqueFields: string[]): Schema {
  // Build schema definition dynamically
  const schemaDefinition: Record<string, object> = {
    _id: {
      type: Schema.Types.ObjectId,
      default: () => new Types.ObjectId(),
    },
    // Reference to the document
    docId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    // Branch this key entry belongs to
    branchId: {
      type: Schema.Types.ObjectId,
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
      type: Schema.Types.Mixed,
      required: false, // Allow null for optional unique fields
    };
  }

  const schema = new Schema(schemaDefinition, {
    timestamps: true,
  });

  // Compound unique index for docId + branchId
  schema.index({ docId: 1, branchId: 1 }, { unique: true, name: 'chronicle_keys_doc_branch' });

  // Create unique indexes for each unique field (per branch, excluding deleted)
  for (const field of uniqueFields) {
    schema.index(
      { [`key_${field}`]: 1, branchId: 1 },
      {
        unique: true,
        sparse: true, // Allow multiple nulls
        partialFilterExpression: { isDeleted: false, [`key_${field}`]: { $exists: true, $ne: null } },
        name: `chronicle_keys_unique_${field}`,
      }
    );
  }

  return schema;
}

// Compound indexes for efficient queries
ChronicleMetadataSchema.index({ docId: 1, metadataStatus: 1 });
ChronicleBranchSchema.index({ docId: 1, name: 1 });
