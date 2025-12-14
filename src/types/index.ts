import type { Types, Document } from 'mongoose';

/**
 * ChronicleChunk types
 * 1 = full (fully hydrated payload/Original Document)
 * 2 = delta (payload is only the changes since previous Chunk)
 */
export enum ChunkType {
  FULL = 1,
  DELTA = 2,
}

/**
 * Configuration options for the mongoose-chronicle plugin
 */
export interface ChroniclePluginOptions {
  /**
   * The property name to use as the document identifier.
   * Defaults to '_id' of the original document.
   */
  primaryKey?: string;

  /**
   * Number of delta chunks before creating a new full chunk.
   * Defaults to 10.
   */
  fullChunkInterval?: number;

  /**
   * Array of field names that should be indexed in the payload.
   * If not specified, indexes from original schema are used.
   */
  indexes?: string[];

  /**
   * Array of field names that should have unique constraints.
   * If not specified, unique fields from original schema are used.
   */
  uniqueKeys?: string[];

  /**
   * Name of the collection to store chronicle configuration.
   * Defaults to 'chronicle_config'.
   */
  configCollectionName?: string;

  /**
   * Name of the collection to store chronicle metadata.
   * Defaults to '{originalCollectionName}_chronicle_metadata'.
   */
  metadataCollectionName?: string;

  /**
   * Maximum number of documents that deleteMany can affect before throwing an error.
   * Use { chronicleForceDeleteMany: true } in query options to bypass.
   * Defaults to 100.
   */
  deleteManyLimit?: number;
}

/**
 * Chronicle Metadata document schema
 * Stores metadata about chronicle documents like active branch
 */
export interface ChronicleMetadata {
  _id: Types.ObjectId;
  /** The docId this metadata belongs to */
  docId: Types.ObjectId;
  /** Currently active branch for this document */
  activeBranchId: Types.ObjectId;
  /** Epoch/generation number - increments when doc is recreated after deletion */
  epoch: number;
  /** Status of metadata: 'pending' | 'active' | 'orphaned' */
  metadataStatus: 'pending' | 'active' | 'orphaned';
  /** Creation timestamp */
  createdAt: Date;
  /** Last updated timestamp */
  updatedAt: Date;
}

/**
 * Branch document schema
 * Represents a branch in the chronicle history
 */
export interface ChronicleBranch {
  _id: Types.ObjectId;
  /** The docId this branch belongs to */
  docId: Types.ObjectId;
  /** Epoch/generation number */
  epoch: number;
  /** Parent branch ID (null for main branch) */
  parentBranchId: Types.ObjectId | null;
  /** Serial number in parent branch where this branch was created */
  parentSerial: number | null;
  /** Human-readable name for the branch */
  name: string;
  /** Creation timestamp */
  createdAt: Date;
}

/**
 * ChronicleChunk document structure
 * The wrapper document that stores original documents with versioning
 */
export interface ChronicleChunk<T = Record<string, unknown>> {
  /** Unique ChronicleChunk ID */
  _id: Types.ObjectId;
  /** Identifies the unique original document */
  docId: Types.ObjectId;
  /** Epoch/generation number - supports document re-creation after deletion */
  epoch: number;
  /** Branch this chunk belongs to */
  branchId: Types.ObjectId;
  /** Sequential number within the branch, starts at 1 */
  serial: number;
  /** Chunk type: 1 = full, 2 = delta */
  ccType: ChunkType;
  /** Soft delete flag */
  isDeleted: boolean;
  /** Flag indicating this is the latest chunk for docId+branchId */
  isLatest: boolean;
  /** Creation timestamp */
  cTime: Date;
  /** The payload - either full document or delta changes */
  payload: Partial<T>;
}

/**
 * Chronicle configuration stored in the config collection
 */
export interface ChronicleConfig {
  _id: Types.ObjectId;
  /** Collection name this config applies to */
  collectionName: string;
  /** Full chunk interval setting */
  fullChunkInterval: number;
  /** Plugin version for migrations */
  pluginVersion: string;
  /** Fields that are indexed in the original schema */
  indexedFields: string[];
  /** Fields that have unique constraints in the original schema */
  uniqueFields: string[];
  /** Creation timestamp */
  createdAt: Date;
  /** Last updated timestamp */
  updatedAt: Date;
}

/**
 * Chronicle Keys document structure
 * Maintains current unique key values for fast uniqueness checks
 */
export interface ChronicleKeys {
  _id: Types.ObjectId;
  /** Reference to the document */
  docId: Types.ObjectId;
  /** Branch this key entry belongs to */
  branchId: Types.ObjectId;
  /** Whether the document is deleted */
  isDeleted: boolean;
  /** Dynamic key fields prefixed with key_ */
  [key: `key_${string}`]: unknown;
  /** Creation timestamp */
  createdAt: Date;
  /** Last updated timestamp */
  updatedAt: Date;
}

/**
 * Options for querying historical data
 */
export interface ChronicleQueryOptions {
  /** Get document state as of this date/time */
  asOf?: Date;
  /** Specific branch to query */
  branchId?: Types.ObjectId;
  /** Include deleted documents */
  includeDeleted?: boolean;
}

/**
 * Options for creating a new branch
 */
export interface CreateBranchOptions {
  /**
   * Whether to activate the branch after creation.
   * When true, subsequent saves will be recorded on the new branch.
   * Defaults to true (matches Git's checkout -b behavior).
   */
  activate?: boolean;
  /**
   * Serial number to branch from.
   * If not specified, branches from the latest serial on the active branch.
   */
  fromSerial?: number;
}

/**
 * Options for reverting chronicle history
 */
export interface RevertOptions {
  /**
   * Target branch to revert. Defaults to active branch.
   */
  branchId?: Types.ObjectId;
  /**
   * If true, update the document's current state to match the reverted state.
   * Defaults to true.
   */
  rehydrate?: boolean;
}

/**
 * Result of a chronicle revert operation
 */
export interface RevertResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** The serial number that is now the latest */
  revertedToSerial: number;
  /** Number of chunks that were removed */
  chunksRemoved: number;
  /** Number of branches whose parentSerial was updated */
  branchesUpdated: number;
  /** The rehydrated document state (if rehydrate was true) */
  state?: Record<string, unknown>;
}

/**
 * Options for squashing chronicle history
 */
export interface SquashOptions {
  /**
   * Which branch the target serial is on. Defaults to active branch.
   */
  branchId?: Types.ObjectId;
  /**
   * Safety flag - must be true to execute the squash.
   * This is a destructive, irreversible operation.
   */
  confirm: boolean;
  /**
   * If true, preview what would be deleted without executing.
   */
  dryRun?: boolean;
}

/**
 * Result of a chronicle squash operation
 */
export interface SquashResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Number of chunks that existed before squash */
  previousChunkCount: number;
  /** Number of branches that existed before squash */
  previousBranchCount: number;
  /** The new base state after squash */
  newState: Record<string, unknown>;
}

/**
 * Result of a squash dry run
 */
export interface SquashDryRunResult {
  /** Preview of what would be deleted */
  wouldDelete: {
    chunks: number;
    branches: number;
  };
  /** The state that would become the new base */
  newBaseState: Record<string, unknown>;
}

/**
 * Options for point-in-time document rehydration
 */
export interface AsOfOptions {
  /**
   * Specific branch to query. If not provided, uses the active branch.
   */
  branchId?: Types.ObjectId;

  /**
   * If true, searches across all branches and returns the state from
   * whichever branch had the most recent chunk at or before the timestamp.
   * Mutually exclusive with branchId.
   * Default: false
   */
  searchAllBranches?: boolean;
}

/**
 * Result of a point-in-time document rehydration
 */
export interface AsOfResult {
  /**
   * Whether a valid state was found at the given timestamp
   */
  found: boolean;

  /**
   * The rehydrated document state at the given timestamp.
   * Undefined if found is false.
   */
  state?: Record<string, unknown>;

  /**
   * The serial number of the chunk that was current at the given timestamp
   */
  serial?: number;

  /**
   * The branch ID from which the state was retrieved
   */
  branchId?: Types.ObjectId;

  /**
   * The exact timestamp of the chunk used (may be earlier than requested asOf)
   */
  chunkTimestamp?: Date;
}

/**
 * Extended document type with chronicle methods
 */
export interface ChronicleDocument extends Document {
  /** Get the chronicle history for this document */
  getHistory(): Promise<ChronicleChunk[]>;
  /** Create a snapshot at the current state */
  createSnapshot(name: string): Promise<ChronicleBranch>;
  /** Get available branches for this document */
  getBranches(): Promise<ChronicleBranch[]>;
}

/**
 * Extended schema type with chronicle static methods
 */
export interface ChronicleModel<T extends Document> {
  /** Find document as it existed at a specific point in time */
  findAsOf(filter: Record<string, unknown>, asOf: Date): Promise<T | null>;
  /**
   * Create a new branch from a document's current state.
   * By default, activates the branch so subsequent saves go to the new branch.
   */
  createBranch(docId: Types.ObjectId, branchName: string, options?: CreateBranchOptions): Promise<ChronicleBranch>;
  /** Switch to a different branch */
  switchBranch(docId: Types.ObjectId, branchId: Types.ObjectId): Promise<void>;
  /** Get all branches for a document */
  listBranches(docId: Types.ObjectId): Promise<ChronicleBranch[]>;
  /** Get the currently active branch for a document */
  getActiveBranch(docId: Types.ObjectId): Promise<ChronicleBranch | null>;
  /**
   * Revert a branch's history to a specific serial, removing newer chunks.
   * Does not affect other branches.
   */
  chronicleRevert(docId: Types.ObjectId, serial: number, options?: RevertOptions): Promise<RevertResult>;
  /**
   * Squash all chronicle history into a single FULL chunk.
   * This is a destructive, irreversible operation that removes all branches and history.
   */
  chronicleSquash(docId: Types.ObjectId, serial: number, options: SquashOptions): Promise<SquashResult | SquashDryRunResult>;
  /**
   * Get the document state at a specific point in time.
   * Rehydrates the document from chunks created at or before the given timestamp.
   */
  chronicleAsOf(docId: Types.ObjectId, asOf: Date, options?: AsOfOptions): Promise<AsOfResult>;
  /**
   * Soft delete a document by creating a deletion chunk.
   * The document's chronicle history is preserved.
   */
  chronicleSoftDelete(docId: Types.ObjectId): Promise<{ chunkId: Types.ObjectId; finalState: Record<string, unknown> }>;
  /**
   * Restore a soft-deleted document.
   */
  chronicleUndelete(docId: Types.ObjectId, options?: UndeleteOptions): Promise<UndeleteResult>;
  /**
   * List all soft-deleted documents.
   */
  chronicleListDeleted(filters?: ListDeletedFilters): Promise<DeletedDocInfo[]>;
  /**
   * Permanently remove all chronicle data for a document.
   * This is irreversible and requires explicit confirmation.
   */
  chroniclePurge(docId: Types.ObjectId, options: PurgeOptions): Promise<PurgeResult>;
}

/**
 * Options for restoring a soft-deleted document
 */
export interface UndeleteOptions {
  /** Which incarnation to restore (default: latest epoch) */
  epoch?: number;
  /** Which branch to restore from (default: main at deletion) */
  branchId?: Types.ObjectId;
}

/**
 * Result of restoring a soft-deleted document
 */
export interface UndeleteResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** The document ID */
  docId: Types.ObjectId;
  /** The epoch of the restored document */
  epoch: number;
  /** The restored document state */
  restoredState: Record<string, unknown>;
}

/**
 * Filters for listing deleted documents
 */
export interface ListDeletedFilters {
  /** Only include documents deleted after this date */
  deletedAfter?: Date;
  /** Only include documents deleted before this date */
  deletedBefore?: Date;
}

/**
 * Information about a deleted document
 */
export interface DeletedDocInfo {
  /** The document ID */
  docId: Types.ObjectId;
  /** The epoch/generation of the deleted document */
  epoch: number;
  /** When the document was deleted */
  deletedAt: Date;
  /** The final state before deletion */
  finalState: Record<string, unknown>;
}

/**
 * Options for permanently purging chronicle data
 */
export interface PurgeOptions {
  /** Safety flag - must be true to execute (required) */
  confirm: true;
  /** Purge only a specific epoch (default: all epochs) */
  epoch?: number;
}

/**
 * Result of a chronicle purge operation
 */
export interface PurgeResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** The document ID */
  docId: Types.ObjectId;
  /** Which epochs were purged */
  epochsPurged: number[];
  /** Number of chunks removed */
  chunksRemoved: number;
  /** Number of branches removed */
  branchesRemoved: number;
}
