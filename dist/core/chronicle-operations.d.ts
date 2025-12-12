import { Types, type Connection, type Document } from 'mongoose';
import type { ChroniclePluginOptions, ChunkType, ChronicleBranch, CreateBranchOptions } from '../types';
/**
 * Error thrown when a unique constraint violation is detected
 */
export declare class ChronicleUniqueConstraintError extends Error {
    field: string;
    value: unknown;
    constructor(field: string, value: unknown);
}
/**
 * Context for chronicle operations, passed to middleware
 */
export interface ChronicleContext {
    connection: Connection;
    /** The base collection name (original model collection) */
    baseCollectionName: string;
    /** The collection name for chronicle chunks */
    chunksCollectionName: string;
    options: ChroniclePluginOptions;
    uniqueFields: string[];
    indexedFields: string[];
}
/**
 * Result of looking up or creating chronicle metadata for a document
 */
export interface ChronicleDocumentState {
    docId: Types.ObjectId;
    branchId: Types.ObjectId;
    currentSerial: number;
    isNew: boolean;
    previousPayload?: Record<string, unknown>;
}
/**
 * Validates that unique fields don't conflict with existing documents
 * @param ctx - Chronicle context
 * @param payload - The document payload to validate
 * @param excludeDocId - DocId to exclude from check (for updates)
 * @param branchId - Branch to check uniqueness within
 */
export declare function validateUniqueConstraints(ctx: ChronicleContext, payload: Record<string, unknown>, branchId: Types.ObjectId, excludeDocId?: Types.ObjectId): Promise<void>;
/**
 * Updates the chronicle keys collection with new unique key values
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID
 * @param payload - The full document payload
 * @param isDeleted - Whether the document is being deleted
 */
export declare function updateChronicleKeys(ctx: ChronicleContext, docId: Types.ObjectId, branchId: Types.ObjectId, payload: Record<string, unknown>, isDeleted?: boolean): Promise<void>;
/**
 * Marks previous chunks as not latest
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID
 */
export declare function clearIsLatestFlag(ctx: ChronicleContext, docId: Types.ObjectId, branchId: Types.ObjectId): Promise<void>;
/**
 * Gets or creates the chronicle metadata for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID (MongoDB _id - Mongoose assigns this before save even for new docs)
 * @param isNew - Whether this is a new document being created
 * @returns The document state including branch and serial info
 */
export declare function getOrCreateDocumentState(ctx: ChronicleContext, docId: Types.ObjectId, isNew: boolean): Promise<ChronicleDocumentState>;
/**
 * Rehydrates a document from its chunks
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID
 * @param asOf - Optional timestamp for point-in-time query
 */
export declare function rehydrateDocument(ctx: ChronicleContext, docId: Types.ObjectId, branchId: Types.ObjectId, asOf?: Date): Promise<Record<string, unknown> | undefined>;
/**
 * Creates a new chronicle chunk
 * @param ctx - Chronicle context
 * @param state - Document state from getOrCreateDocumentState
 * @param payload - The document payload (full or delta)
 * @param ccType - Chunk type (1=FULL, 2=DELTA)
 * @param isDeleted - Whether this marks a deletion
 */
export declare function createChronicleChunk(ctx: ChronicleContext, state: ChronicleDocumentState, payload: Record<string, unknown>, ccType: ChunkType, isDeleted?: boolean): Promise<Types.ObjectId>;
/**
 * Determines whether to write a full chunk or delta based on the interval
 * @param currentSerial - Current serial number
 * @param fullChunkInterval - Configured interval for full chunks
 */
export declare function shouldWriteFullChunk(currentSerial: number, fullChunkInterval: number): boolean;
/**
 * Finalizes the chronicle operation by updating metadata status
 * @param ctx - Chronicle context
 * @param docId - Document ID
 */
export declare function finalizeChronicleOperation(ctx: ChronicleContext, docId: Types.ObjectId): Promise<void>;
/**
 * Processes a document save operation for chronicle
 * @param ctx - Chronicle context
 * @param doc - The mongoose document being saved
 * @param isNew - Whether this is a new document
 */
export declare function processChroniclesSave(ctx: ChronicleContext, doc: Document, isNew: boolean): Promise<{
    docId: Types.ObjectId;
    chunkId: Types.ObjectId;
}>;
/**
 * Creates a new branch for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchName - Name for the new branch
 * @param options - Branch creation options
 * @returns The created branch
 */
export declare function createBranch(ctx: ChronicleContext, docId: Types.ObjectId, branchName: string, options?: CreateBranchOptions): Promise<ChronicleBranch>;
/**
 * Switches the active branch for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID to switch to
 */
export declare function switchBranch(ctx: ChronicleContext, docId: Types.ObjectId, branchId: Types.ObjectId): Promise<void>;
/**
 * Lists all branches for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @returns Array of branches
 */
export declare function listBranches(ctx: ChronicleContext, docId: Types.ObjectId): Promise<ChronicleBranch[]>;
/**
 * Gets the currently active branch for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @returns The active branch or null if not found
 */
export declare function getActiveBranch(ctx: ChronicleContext, docId: Types.ObjectId): Promise<ChronicleBranch | null>;
//# sourceMappingURL=chronicle-operations.d.ts.map