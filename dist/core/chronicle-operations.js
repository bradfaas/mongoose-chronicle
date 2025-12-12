"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChronicleUniqueConstraintError = void 0;
exports.validateUniqueConstraints = validateUniqueConstraints;
exports.updateChronicleKeys = updateChronicleKeys;
exports.clearIsLatestFlag = clearIsLatestFlag;
exports.getOrCreateDocumentState = getOrCreateDocumentState;
exports.rehydrateDocument = rehydrateDocument;
exports.createChronicleChunk = createChronicleChunk;
exports.shouldWriteFullChunk = shouldWriteFullChunk;
exports.finalizeChronicleOperation = finalizeChronicleOperation;
exports.processChroniclesSave = processChroniclesSave;
exports.createBranch = createBranch;
exports.switchBranch = switchBranch;
exports.listBranches = listBranches;
exports.getActiveBranch = getActiveBranch;
exports.chronicleRevert = chronicleRevert;
exports.chronicleSquash = chronicleSquash;
exports.chronicleAsOf = chronicleAsOf;
const mongoose_1 = require("mongoose");
const delta_1 = require("../utils/delta");
/**
 * Error thrown when a unique constraint violation is detected
 */
class ChronicleUniqueConstraintError extends Error {
    field;
    value;
    constructor(field, value) {
        super(`Duplicate key error: ${field} "${value}" already exists`);
        this.name = 'ChronicleUniqueConstraintError';
        this.field = field;
        this.value = value;
    }
}
exports.ChronicleUniqueConstraintError = ChronicleUniqueConstraintError;
/**
 * Validates that unique fields don't conflict with existing documents
 * @param ctx - Chronicle context
 * @param payload - The document payload to validate
 * @param excludeDocId - DocId to exclude from check (for updates)
 * @param branchId - Branch to check uniqueness within
 */
async function validateUniqueConstraints(ctx, payload, branchId, excludeDocId) {
    if (ctx.uniqueFields.length === 0) {
        return;
    }
    const keysCollectionName = `${ctx.baseCollectionName}_chronicle_keys`;
    const keysCollection = ctx.connection.db?.collection(keysCollectionName);
    if (!keysCollection) {
        return; // Keys collection doesn't exist, skip validation
    }
    for (const field of ctx.uniqueFields) {
        const value = payload[field];
        // Skip if value is null/undefined (sparse unique)
        if (value === null || value === undefined) {
            continue;
        }
        // Build query to find conflicting documents
        const query = {
            [`key_${field}`]: value,
            branchId,
            isDeleted: false,
        };
        // Exclude current document when updating
        if (excludeDocId) {
            query.docId = { $ne: excludeDocId };
        }
        const existing = await keysCollection.findOne(query);
        if (existing) {
            throw new ChronicleUniqueConstraintError(field, value);
        }
    }
}
/**
 * Updates the chronicle keys collection with new unique key values
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID
 * @param payload - The full document payload
 * @param isDeleted - Whether the document is being deleted
 */
async function updateChronicleKeys(ctx, docId, branchId, payload, isDeleted = false) {
    if (ctx.uniqueFields.length === 0) {
        return;
    }
    const keysCollectionName = `${ctx.baseCollectionName}_chronicle_keys`;
    const keysCollection = ctx.connection.db?.collection(keysCollectionName);
    if (!keysCollection) {
        return;
    }
    // Build the key document
    const keyDoc = {
        docId,
        branchId,
        isDeleted,
        updatedAt: new Date(),
    };
    // Add each unique field value
    for (const field of ctx.uniqueFields) {
        keyDoc[`key_${field}`] = payload[field] ?? null;
    }
    // Upsert the keys document
    await keysCollection.updateOne({ docId, branchId }, {
        $set: keyDoc,
        $setOnInsert: { createdAt: new Date() },
    }, { upsert: true });
}
/**
 * Marks previous chunks as not latest
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID
 */
async function clearIsLatestFlag(ctx, docId, branchId) {
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!chunksCollection) {
        return;
    }
    await chunksCollection.updateMany({ docId, branchId, isLatest: true }, { $set: { isLatest: false } });
}
/**
 * Gets or creates the chronicle metadata for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID (MongoDB _id - Mongoose assigns this before save even for new docs)
 * @param isNew - Whether this is a new document being created
 * @returns The document state including branch and serial info
 */
async function getOrCreateDocumentState(ctx, docId, isNew) {
    const metadataCollectionName = ctx.options.metadataCollectionName ??
        `${ctx.baseCollectionName}_chronicle_metadata`;
    const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;
    const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
    const branchCollection = ctx.connection.db?.collection(branchCollectionName);
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!metadataCollection || !branchCollection || !chunksCollection) {
        throw new Error('Chronicle collections not initialized');
    }
    // For new documents - use the MongoDB _id as the chronicle docId
    // This ensures consistency between the document's _id and chronicle tracking
    if (isNew) {
        const newBranchId = new mongoose_1.Types.ObjectId();
        // Create the main branch using the document's _id
        await branchCollection.insertOne({
            _id: newBranchId,
            docId: docId, // Use the MongoDB _id
            parentBranchId: null,
            parentSerial: null,
            name: 'main',
            createdAt: new Date(),
        });
        // Create metadata pointing to main branch
        await metadataCollection.insertOne({
            _id: new mongoose_1.Types.ObjectId(),
            docId: docId, // Use the MongoDB _id
            activeBranchId: newBranchId,
            metadataStatus: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        return {
            docId: docId, // Return the MongoDB _id
            branchId: newBranchId,
            currentSerial: 0,
            isNew: true,
        };
    }
    // For existing documents - look up by the MongoDB _id
    const metadata = await metadataCollection.findOne({ docId });
    if (!metadata) {
        throw new Error(`Chronicle metadata not found for document ${docId}`);
    }
    // Get the latest chunk to find current serial
    const latestChunk = await chunksCollection.findOne({ docId, branchId: metadata.activeBranchId, isLatest: true }, { projection: { serial: 1, payload: 1 } });
    // If there's a latest chunk, we need to rehydrate to get full payload
    let previousPayload;
    if (latestChunk) {
        previousPayload = await rehydrateDocument(ctx, docId, metadata.activeBranchId);
    }
    return {
        docId,
        branchId: metadata.activeBranchId,
        currentSerial: latestChunk?.serial ?? 0,
        isNew: false,
        previousPayload,
    };
}
/**
 * Rehydrates a document from its chunks
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID
 * @param asOf - Optional timestamp for point-in-time query
 */
async function rehydrateDocument(ctx, docId, branchId, asOf) {
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!chunksCollection) {
        return undefined;
    }
    // Build query for chunks
    const query = { docId, branchId };
    if (asOf) {
        query.cTime = { $lte: asOf };
    }
    // Get chunks ordered by serial
    const chunks = await chunksCollection
        .find(query)
        .sort({ serial: 1 })
        .toArray();
    if (chunks.length === 0) {
        return undefined;
    }
    // Find the most recent full chunk
    let fullChunkIndex = -1;
    for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i]?.ccType === 1) { // FULL
            fullChunkIndex = i;
            break;
        }
    }
    if (fullChunkIndex === -1) {
        // No full chunk found, this shouldn't happen
        return undefined;
    }
    // Start with the full chunk's payload
    let result = { ...chunks[fullChunkIndex]?.payload };
    // Apply subsequent deltas
    for (let i = fullChunkIndex + 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk?.ccType === 2) { // DELTA
            const delta = chunk.payload;
            for (const [key, value] of Object.entries(delta)) {
                if (value === null) {
                    delete result[key];
                }
                else {
                    result[key] = value;
                }
            }
        }
    }
    return result;
}
/**
 * Creates a new chronicle chunk
 * @param ctx - Chronicle context
 * @param state - Document state from getOrCreateDocumentState
 * @param payload - The document payload (full or delta)
 * @param ccType - Chunk type (1=FULL, 2=DELTA)
 * @param isDeleted - Whether this marks a deletion
 */
async function createChronicleChunk(ctx, state, payload, ccType, isDeleted = false) {
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!chunksCollection) {
        throw new Error('Chronicle collection not initialized');
    }
    const chunkId = new mongoose_1.Types.ObjectId();
    const newSerial = state.currentSerial + 1;
    // Clear isLatest on previous chunks
    await clearIsLatestFlag(ctx, state.docId, state.branchId);
    // Insert the new chunk
    await chunksCollection.insertOne({
        _id: chunkId,
        docId: state.docId,
        branchId: state.branchId,
        serial: newSerial,
        ccType,
        isDeleted,
        isLatest: true,
        cTime: new Date(),
        payload,
    });
    return chunkId;
}
/**
 * Determines whether to write a full chunk or delta based on the interval
 * @param currentSerial - Current serial number
 * @param fullChunkInterval - Configured interval for full chunks
 */
function shouldWriteFullChunk(currentSerial, fullChunkInterval) {
    // Always write full for first chunk
    if (currentSerial === 0) {
        return true;
    }
    // Write full every N chunks
    return (currentSerial + 1) % fullChunkInterval === 0;
}
/**
 * Finalizes the chronicle operation by updating metadata status
 * @param ctx - Chronicle context
 * @param docId - Document ID
 */
async function finalizeChronicleOperation(ctx, docId) {
    const metadataCollectionName = ctx.options.metadataCollectionName ??
        `${ctx.baseCollectionName}_chronicle_metadata`;
    const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
    if (!metadataCollection) {
        return;
    }
    await metadataCollection.updateOne({ docId }, {
        $set: {
            metadataStatus: 'active',
            updatedAt: new Date(),
        },
    });
}
/**
 * Processes a document save operation for chronicle
 * @param ctx - Chronicle context
 * @param doc - The mongoose document being saved
 * @param isNew - Whether this is a new document
 */
async function processChroniclesSave(ctx, doc, isNew) {
    const payload = doc.toObject({ getters: false, virtuals: false });
    delete payload._id;
    delete payload.__v;
    // Get or create document state
    // Always pass doc._id - Mongoose assigns _id before save even for new documents
    // This ensures chronicle docId matches the MongoDB _id for consistent lookups
    const state = await getOrCreateDocumentState(ctx, doc._id, isNew);
    // Validate unique constraints
    await validateUniqueConstraints(ctx, payload, state.branchId, isNew ? undefined : state.docId);
    // Determine chunk type and payload
    const fullChunkInterval = ctx.options.fullChunkInterval ?? 10;
    let chunkPayload;
    let chunkType;
    if (shouldWriteFullChunk(state.currentSerial, fullChunkInterval)) {
        // Write full chunk
        chunkPayload = payload;
        chunkType = 1; // FULL
    }
    else {
        // Write delta chunk
        const delta = (0, delta_1.computeDelta)(state.previousPayload ?? {}, payload);
        if ((0, delta_1.isDeltaEmpty)(delta)) {
            // No changes, skip writing
            return { docId: state.docId, chunkId: new mongoose_1.Types.ObjectId() };
        }
        chunkPayload = delta;
        chunkType = 2; // DELTA
    }
    // Create the chunk
    const chunkId = await createChronicleChunk(ctx, state, chunkPayload, chunkType);
    // Update chronicle keys for unique fields
    await updateChronicleKeys(ctx, state.docId, state.branchId, payload);
    // Finalize the operation
    await finalizeChronicleOperation(ctx, state.docId);
    return { docId: state.docId, chunkId };
}
/**
 * Creates a new branch for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchName - Name for the new branch
 * @param options - Branch creation options
 * @returns The created branch
 */
async function createBranch(ctx, docId, branchName, options = {}) {
    const { activate = true, fromSerial } = options;
    const metadataCollectionName = ctx.options.metadataCollectionName ??
        `${ctx.baseCollectionName}_chronicle_metadata`;
    const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;
    const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
    const branchCollection = ctx.connection.db?.collection(branchCollectionName);
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!metadataCollection || !branchCollection || !chunksCollection) {
        throw new Error('Chronicle collections not initialized');
    }
    // Get current metadata to find active branch
    const metadata = await metadataCollection.findOne({ docId });
    if (!metadata) {
        throw new Error(`Chronicle metadata not found for document ${docId}`);
    }
    const parentBranchId = metadata.activeBranchId;
    // Determine the serial to branch from
    let parentSerial;
    if (fromSerial !== undefined) {
        // Verify the specified serial exists
        const chunk = await chunksCollection.findOne({
            docId,
            branchId: parentBranchId,
            serial: fromSerial,
        });
        if (!chunk) {
            throw new Error(`Serial ${fromSerial} not found on current branch`);
        }
        parentSerial = fromSerial;
    }
    else {
        // Use the latest serial
        const latestChunk = await chunksCollection.findOne({ docId, branchId: parentBranchId, isLatest: true }, { projection: { serial: 1 } });
        if (!latestChunk) {
            throw new Error('No chunks found for document on current branch');
        }
        parentSerial = latestChunk.serial;
    }
    // Create the new branch
    const newBranchId = new mongoose_1.Types.ObjectId();
    const now = new Date();
    const branchDoc = {
        _id: newBranchId,
        docId,
        parentBranchId,
        parentSerial,
        name: branchName,
        createdAt: now,
    };
    await branchCollection.insertOne(branchDoc);
    // Rehydrate the document state at the branch point
    const documentState = await rehydrateDocumentAtSerial(ctx, docId, parentBranchId, parentSerial);
    if (!documentState) {
        throw new Error('Failed to rehydrate document state at branch point');
    }
    // Create a FULL chunk for the new branch with the state at the branch point
    await chunksCollection.insertOne({
        _id: new mongoose_1.Types.ObjectId(),
        docId,
        branchId: newBranchId,
        serial: 1,
        ccType: 1, // FULL
        isDeleted: false,
        isLatest: true,
        cTime: now,
        payload: documentState,
    });
    // Activate the branch if requested (default: true)
    if (activate) {
        await metadataCollection.updateOne({ docId }, { $set: { activeBranchId: newBranchId, updatedAt: now } });
    }
    return branchDoc;
}
/**
 * Rehydrates a document at a specific serial number
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID
 * @param serial - Serial number to rehydrate to
 */
async function rehydrateDocumentAtSerial(ctx, docId, branchId, serial) {
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!chunksCollection) {
        return undefined;
    }
    // Get all chunks up to and including the target serial
    const chunks = await chunksCollection
        .find({ docId, branchId, serial: { $lte: serial } })
        .sort({ serial: 1 })
        .toArray();
    if (chunks.length === 0) {
        return undefined;
    }
    // Find the most recent full chunk at or before target serial
    let fullChunkIndex = -1;
    for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i]?.ccType === 1) { // FULL
            fullChunkIndex = i;
            break;
        }
    }
    if (fullChunkIndex === -1) {
        return undefined;
    }
    // Start with the full chunk's payload
    const result = { ...chunks[fullChunkIndex]?.payload };
    // Apply subsequent deltas up to target serial
    for (let i = fullChunkIndex + 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk?.ccType === 2) { // DELTA
            const delta = chunk.payload;
            for (const [key, value] of Object.entries(delta)) {
                if (value === null) {
                    // Use undefined assignment to remove the key (avoids delete operator)
                    result[key] = undefined;
                }
                else {
                    result[key] = value;
                }
            }
        }
    }
    // Clean up undefined values
    for (const key of Object.keys(result)) {
        if (result[key] === undefined) {
            const { [key]: _, ...rest } = result;
            Object.assign(result, rest);
            // Actually remove the key
            Reflect.deleteProperty(result, key);
        }
    }
    return result;
}
/**
 * Switches the active branch for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param branchId - Branch ID to switch to
 */
async function switchBranch(ctx, docId, branchId) {
    const metadataCollectionName = ctx.options.metadataCollectionName ??
        `${ctx.baseCollectionName}_chronicle_metadata`;
    const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;
    const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
    const branchCollection = ctx.connection.db?.collection(branchCollectionName);
    if (!metadataCollection || !branchCollection) {
        throw new Error('Chronicle collections not initialized');
    }
    // Verify the branch exists and belongs to this document
    const branch = await branchCollection.findOne({ _id: branchId, docId });
    if (!branch) {
        throw new Error(`Branch ${branchId} not found for document ${docId}`);
    }
    // Update the active branch
    const result = await metadataCollection.updateOne({ docId }, { $set: { activeBranchId: branchId, updatedAt: new Date() } });
    if (result.matchedCount === 0) {
        throw new Error(`Chronicle metadata not found for document ${docId}`);
    }
}
/**
 * Lists all branches for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @returns Array of branches
 */
async function listBranches(ctx, docId) {
    const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;
    const branchCollection = ctx.connection.db?.collection(branchCollectionName);
    if (!branchCollection) {
        throw new Error('Chronicle collections not initialized');
    }
    const branches = await branchCollection
        .find({ docId })
        .sort({ createdAt: 1 })
        .toArray();
    return branches;
}
/**
 * Gets the currently active branch for a document
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @returns The active branch or null if not found
 */
async function getActiveBranch(ctx, docId) {
    const metadataCollectionName = ctx.options.metadataCollectionName ??
        `${ctx.baseCollectionName}_chronicle_metadata`;
    const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;
    const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
    const branchCollection = ctx.connection.db?.collection(branchCollectionName);
    if (!metadataCollection || !branchCollection) {
        return null;
    }
    const metadata = await metadataCollection.findOne({ docId });
    if (!metadata) {
        return null;
    }
    const branch = await branchCollection.findOne({ _id: metadata.activeBranchId });
    return branch;
}
/**
 * Reverts a branch's history to a specific serial, removing all chunks newer than the target.
 * This operation only affects the specified branch and does not touch other branches.
 *
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param serial - The serial number to revert to (becomes the new "latest")
 * @param options - Revert options
 * @returns Result containing success status, counts, and optionally the rehydrated state
 */
async function chronicleRevert(ctx, docId, serial, options = {}) {
    const { rehydrate = true } = options;
    const metadataCollectionName = ctx.options.metadataCollectionName ??
        `${ctx.baseCollectionName}_chronicle_metadata`;
    const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;
    const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
    const branchCollection = ctx.connection.db?.collection(branchCollectionName);
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!metadataCollection || !branchCollection || !chunksCollection) {
        throw new Error('Chronicle collections not initialized');
    }
    // Determine target branch
    let branchId;
    if (options.branchId) {
        branchId = options.branchId;
    }
    else {
        const metadata = await metadataCollection.findOne({ docId });
        if (!metadata) {
            throw new Error(`Chronicle metadata not found for document ${docId}`);
        }
        branchId = metadata.activeBranchId;
    }
    // Validate the target serial exists
    const targetChunk = await chunksCollection.findOne({
        docId,
        branchId,
        serial,
    });
    if (!targetChunk) {
        throw new Error(`Serial ${serial} not found on branch ${branchId}`);
    }
    // Check if target is already latest (no-op)
    const latestChunk = await chunksCollection.findOne({
        docId,
        branchId,
        isLatest: true,
    });
    if (latestChunk && latestChunk.serial === serial) {
        // Target is already latest, return early
        let state;
        if (rehydrate) {
            state = await rehydrateDocumentAtSerial(ctx, docId, branchId, serial);
        }
        return {
            success: true,
            revertedToSerial: serial,
            chunksRemoved: 0,
            branchesUpdated: 0,
            state,
        };
    }
    // Delete all chunks with serial > targetSerial on this branch
    const deleteResult = await chunksCollection.deleteMany({
        docId,
        branchId,
        serial: { $gt: serial },
    });
    const chunksRemoved = deleteResult.deletedCount;
    // Update the target chunk to set isLatest: true
    await chunksCollection.updateOne({ docId, branchId, serial }, { $set: { isLatest: true } });
    // Update orphaned branches: branches where parentBranchId === branchId AND parentSerial > serial
    const branchUpdateResult = await branchCollection.updateMany({
        docId,
        parentBranchId: branchId,
        parentSerial: { $gt: serial },
    }, { $set: { parentSerial: serial } });
    const branchesUpdated = branchUpdateResult.modifiedCount;
    // Rehydrate if requested
    let state;
    if (rehydrate) {
        state = await rehydrateDocumentAtSerial(ctx, docId, branchId, serial);
    }
    return {
        success: true,
        revertedToSerial: serial,
        chunksRemoved,
        branchesUpdated,
        state,
    };
}
/**
 * Squashes all chronicle history into a single FULL chunk representing a chosen point in time.
 * This is a destructive, irreversible operation that removes all branches and history.
 *
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param serial - The serial number to use as the new base state
 * @param options - Squash options (confirm must be true to execute)
 * @returns Result containing success status, previous counts, and the new state
 */
async function chronicleSquash(ctx, docId, serial, options) {
    const { confirm, dryRun = false } = options;
    // Safety check - require explicit confirmation unless dry run
    if (!dryRun && confirm !== true) {
        throw new Error('Squash requires explicit confirmation. Set options.confirm = true to execute.');
    }
    const metadataCollectionName = ctx.options.metadataCollectionName ??
        `${ctx.baseCollectionName}_chronicle_metadata`;
    const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;
    const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
    const branchCollection = ctx.connection.db?.collection(branchCollectionName);
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!metadataCollection || !branchCollection || !chunksCollection) {
        throw new Error('Chronicle collections not initialized');
    }
    // Determine target branch
    let branchId;
    if (options.branchId) {
        branchId = options.branchId;
    }
    else {
        const metadata = await metadataCollection.findOne({ docId });
        if (!metadata) {
            throw new Error(`Chronicle metadata not found for document ${docId}`);
        }
        branchId = metadata.activeBranchId;
    }
    // Validate the target serial exists
    const targetChunk = await chunksCollection.findOne({
        docId,
        branchId,
        serial,
    });
    if (!targetChunk) {
        throw new Error(`Serial ${serial} not found on branch ${branchId}`);
    }
    // Count existing chunks and branches
    const previousChunkCount = await chunksCollection.countDocuments({ docId });
    const previousBranchCount = await branchCollection.countDocuments({ docId });
    // Rehydrate the document state at the target serial
    const newBaseState = await rehydrateDocumentAtSerial(ctx, docId, branchId, serial);
    if (!newBaseState) {
        throw new Error('Failed to rehydrate document state at specified serial');
    }
    // If dry run, return preview without making changes
    if (dryRun) {
        return {
            wouldDelete: {
                chunks: previousChunkCount,
                branches: previousBranchCount - 1, // All except the new main
            },
            newBaseState,
        };
    }
    // Delete ALL chunks for this document
    await chunksCollection.deleteMany({ docId });
    // Delete ALL branches for this document
    await branchCollection.deleteMany({ docId });
    // Create new main branch
    const newBranchId = new mongoose_1.Types.ObjectId();
    const now = new Date();
    await branchCollection.insertOne({
        _id: newBranchId,
        docId,
        parentBranchId: null,
        parentSerial: null,
        name: 'main',
        createdAt: now,
    });
    // Create a new FULL chunk with serial 1
    await chunksCollection.insertOne({
        _id: new mongoose_1.Types.ObjectId(),
        docId,
        branchId: newBranchId,
        serial: 1,
        ccType: 1, // FULL
        isDeleted: false,
        isLatest: true,
        cTime: now,
        payload: newBaseState,
    });
    // Update metadata to point to new main branch
    await metadataCollection.updateOne({ docId }, {
        $set: {
            activeBranchId: newBranchId,
            metadataStatus: 'active',
            updatedAt: now,
        },
    });
    return {
        success: true,
        previousChunkCount,
        previousBranchCount,
        newState: newBaseState,
    };
}
/**
 * Gets the document state at a specific point in time.
 * Rehydrates the document from chunks created at or before the given timestamp.
 *
 * @param ctx - Chronicle context
 * @param docId - Document ID
 * @param asOf - The timestamp to query
 * @param options - Query options (branchId or searchAllBranches)
 * @returns Result containing found status, state, and metadata
 */
async function chronicleAsOf(ctx, docId, asOf, options = {}) {
    const { branchId: optionBranchId, searchAllBranches = false } = options;
    // Validate mutually exclusive options
    if (optionBranchId && searchAllBranches) {
        throw new Error('branchId and searchAllBranches are mutually exclusive');
    }
    const metadataCollectionName = ctx.options.metadataCollectionName ??
        `${ctx.baseCollectionName}_chronicle_metadata`;
    const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;
    const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
    const branchCollection = ctx.connection.db?.collection(branchCollectionName);
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!metadataCollection || !branchCollection || !chunksCollection) {
        throw new Error('Chronicle collections not initialized');
    }
    if (searchAllBranches) {
        // Cross-branch search: find the branch with the most recent chunk at or before asOf
        return chronicleAsOfAllBranches(ctx, docId, asOf, chunksCollection, branchCollection);
    }
    // Single branch query
    let branchId;
    if (optionBranchId) {
        branchId = optionBranchId;
    }
    else {
        // Use active branch
        const metadata = await metadataCollection.findOne({ docId });
        if (!metadata) {
            return { found: false };
        }
        branchId = metadata.activeBranchId;
    }
    return chronicleAsOfSingleBranch(ctx, docId, asOf, branchId, chunksCollection);
}
/**
 * Helper function for single-branch asOf query
 */
async function chronicleAsOfSingleBranch(_ctx, docId, asOf, branchId, chunksCollection) {
    // Build query for chunks at or before the asOf timestamp
    const query = {
        docId,
        branchId,
        cTime: { $lte: asOf },
    };
    // Get chunks ordered by serial ascending
    const chunks = await chunksCollection
        .find(query)
        .sort({ serial: 1 })
        .toArray();
    if (chunks.length === 0) {
        return { found: false };
    }
    // Find the most recent FULL chunk
    let fullChunkIndex = -1;
    for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i]?.ccType === 1) { // FULL
            fullChunkIndex = i;
            break;
        }
    }
    if (fullChunkIndex === -1) {
        // No full chunk found before asOf
        return { found: false };
    }
    // Start with the full chunk's payload
    const state = { ...chunks[fullChunkIndex]?.payload };
    // Apply subsequent deltas
    for (let i = fullChunkIndex + 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk?.ccType === 2) { // DELTA
            const delta = chunk.payload;
            for (const [key, value] of Object.entries(delta)) {
                if (value === null) {
                    delete state[key];
                }
                else {
                    state[key] = value;
                }
            }
        }
    }
    // Get the last chunk for metadata (most recent chunk at or before asOf)
    const lastChunk = chunks[chunks.length - 1];
    return {
        found: true,
        state,
        serial: lastChunk?.serial,
        branchId,
        chunkTimestamp: lastChunk?.cTime,
    };
}
/**
 * Helper function for cross-branch asOf query (searchAllBranches: true)
 */
async function chronicleAsOfAllBranches(ctx, docId, asOf, chunksCollection, branchCollection) {
    // Get all branches for this document
    const branches = await branchCollection.find({ docId }).toArray();
    if (branches.length === 0) {
        return { found: false };
    }
    const candidates = [];
    for (const branch of branches) {
        const latestChunk = await chunksCollection.findOne({
            docId,
            branchId: branch._id,
            cTime: { $lte: asOf },
        }, {
            sort: { cTime: -1 },
            projection: { cTime: 1 },
        });
        if (latestChunk) {
            candidates.push({
                branchId: branch._id,
                latestCTime: latestChunk.cTime,
            });
        }
    }
    if (candidates.length === 0) {
        return { found: false };
    }
    // Find the branch with the most recent chunk
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
        const candidate = candidates[i];
        if (candidate && best && candidate.latestCTime > best.latestCTime) {
            best = candidate;
        }
    }
    if (!best) {
        return { found: false };
    }
    // Rehydrate from the winning branch
    return chronicleAsOfSingleBranch(ctx, docId, asOf, best.branchId, chunksCollection);
}
//# sourceMappingURL=chronicle-operations.js.map