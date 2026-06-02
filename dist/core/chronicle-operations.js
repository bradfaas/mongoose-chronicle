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
exports.chronicleSoftDelete = chronicleSoftDelete;
exports.chronicleUndelete = chronicleUndelete;
exports.chronicleListDeleted = chronicleListDeleted;
exports.chroniclePurge = chroniclePurge;
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
        const epoch = 1;
        // Create the main branch using the document's _id
        await branchCollection.insertOne({
            _id: newBranchId,
            docId: docId, // Use the MongoDB _id
            epoch,
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
            epoch,
            metadataStatus: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        return {
            docId: docId, // Return the MongoDB _id
            branchId: newBranchId,
            epoch,
            currentSerial: 0,
            isNew: true,
        };
    }
    // For existing documents - look up by the MongoDB _id
    // Find the latest (highest epoch) metadata for this docId
    const metadata = await metadataCollection.findOne({ docId }, { sort: { epoch: -1 } });
    if (!metadata) {
        throw new Error(`Chronicle metadata not found for document ${docId}`);
    }
    const epoch = metadata.epoch ?? 1;
    // Get the latest chunk to find current serial
    const latestChunk = await chunksCollection.findOne({ docId, epoch, branchId: metadata.activeBranchId, isLatest: true }, { projection: { serial: 1, payload: 1 } });
    // If there's a latest chunk, we need to rehydrate to get full payload
    let previousPayload;
    if (latestChunk) {
        previousPayload = await rehydrateDocument(ctx, docId, metadata.activeBranchId);
    }
    return {
        docId,
        branchId: metadata.activeBranchId,
        epoch,
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
    // Insert the new chunk with epoch
    await chunksCollection.insertOne({
        _id: chunkId,
        docId: state.docId,
        epoch: state.epoch,
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
    const epoch = metadata.epoch ?? 1;
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
        epoch,
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
        epoch,
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
        // Sync main collection: recreate document if missing or soft-deleted
        const baseCollection = ctx.connection.db?.collection(ctx.baseCollectionName);
        if (baseCollection) {
            const mainDoc = await baseCollection.findOne({ _id: docId });
            if (!mainDoc || mainDoc.__chronicle_deleted === true) {
                // Document missing or soft-deleted - restore it with branch state
                await baseCollection.updateOne({ _id: docId }, {
                    $set: {
                        ...documentState,
                        __chronicle_deleted: false,
                    },
                }, { upsert: true });
            }
        }
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
    // Sync main collection to reflect new branch's state
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    const baseCollection = ctx.connection.db?.collection(ctx.baseCollectionName);
    if (chunksCollection && baseCollection) {
        // Get latest chunk on new branch
        const latestChunk = await chunksCollection.findOne({ docId, branchId, isLatest: true }, { projection: { isDeleted: 1 } });
        if (latestChunk?.isDeleted) {
            // New branch is deleted - mark main doc as deleted
            await baseCollection.updateOne({ _id: docId }, { $set: { __chronicle_deleted: true } });
        }
        else {
            // Rehydrate and sync main collection
            const state = await rehydrateDocument(ctx, docId, branchId);
            if (state) {
                await baseCollection.updateOne({ _id: docId }, { $set: { ...state, __chronicle_deleted: false } }, { upsert: true });
            }
        }
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
    // After squash, reset to epoch 1
    const newEpoch = 1;
    await branchCollection.insertOne({
        _id: newBranchId,
        docId,
        epoch: newEpoch,
        parentBranchId: null,
        parentSerial: null,
        name: 'main',
        createdAt: now,
    });
    // Create a new FULL chunk with serial 1
    await chunksCollection.insertOne({
        _id: new mongoose_1.Types.ObjectId(),
        docId,
        epoch: newEpoch,
        branchId: newBranchId,
        serial: 1,
        ccType: 1, // FULL
        isDeleted: false,
        isLatest: true,
        cTime: now,
        payload: newBaseState,
    });
    // Update metadata to point to new main branch and reset epoch
    await metadataCollection.updateOne({ docId }, {
        $set: {
            activeBranchId: newBranchId,
            epoch: newEpoch,
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
/**
 * Performs a soft delete on a document by creating a deletion chunk.
 * The document's chronicle history is preserved, and the isDeleted flag is set to true.
 * This also marks the chronicle_keys entry as deleted to release unique constraints.
 *
 * @param ctx - Chronicle context
 * @param docId - Document ID to soft delete
 * @returns Result containing the deletion chunk ID and final state
 */
async function chronicleSoftDelete(ctx, docId) {
    const metadataCollectionName = ctx.options.metadataCollectionName ??
        `${ctx.baseCollectionName}_chronicle_metadata`;
    const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!metadataCollection || !chunksCollection) {
        throw new Error('Chronicle collections not initialized');
    }
    // Get the current document state
    const metadata = await metadataCollection.findOne({ docId }, { sort: { epoch: -1 } });
    if (!metadata) {
        throw new Error(`Chronicle metadata not found for document ${docId}`);
    }
    const branchId = metadata.activeBranchId;
    const epoch = metadata.epoch ?? 1;
    // Get the latest chunk to find current serial and payload
    const latestChunk = await chunksCollection.findOne({ docId, epoch, branchId, isLatest: true }, { projection: { serial: 1, payload: 1, isDeleted: 1 } });
    if (!latestChunk) {
        throw new Error(`No chunks found for document ${docId} on active branch`);
    }
    // Check if already deleted
    if (latestChunk.isDeleted) {
        throw new Error(`Document ${docId} is already deleted`);
    }
    // Rehydrate the final state before deletion
    const finalState = await rehydrateDocument(ctx, docId, branchId);
    if (!finalState) {
        throw new Error(`Failed to rehydrate document ${docId} for deletion`);
    }
    // Create the document state for chunk creation
    const state = {
        docId,
        branchId,
        epoch,
        currentSerial: latestChunk.serial,
        isNew: false,
        previousPayload: finalState,
    };
    // Create a deletion chunk (FULL chunk with isDeleted: true)
    // The payload contains the final state at time of deletion
    const chunkId = await createChronicleChunk(ctx, state, finalState, 1, // FULL chunk
    true // isDeleted
    );
    // Mark the chronicle_keys entry as deleted to release unique constraints
    await updateChronicleKeys(ctx, docId, branchId, finalState, true);
    return { chunkId, finalState };
}
/**
 * Restores a soft-deleted document by creating a new chunk that marks it as not deleted.
 * Optionally can restore to a specific epoch if multiple deletion cycles have occurred.
 *
 * @param ctx - Chronicle context
 * @param docId - Document ID to restore
 * @param options - Undelete options
 * @returns Result containing success status and restored state
 */
async function chronicleUndelete(ctx, docId, options = {}) {
    const metadataCollectionName = ctx.options.metadataCollectionName ??
        `${ctx.baseCollectionName}_chronicle_metadata`;
    const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!metadataCollection || !chunksCollection) {
        throw new Error('Chronicle collections not initialized');
    }
    // Determine which epoch to restore
    let targetEpoch;
    if (options.epoch !== undefined) {
        targetEpoch = options.epoch;
    }
    else {
        // Find the latest epoch for this document
        const metadata = await metadataCollection.findOne({ docId }, { sort: { epoch: -1 } });
        if (!metadata) {
            throw new Error(`Chronicle metadata not found for document ${docId}`);
        }
        targetEpoch = metadata.epoch ?? 1;
    }
    // Get metadata for the target epoch
    const metadata = await metadataCollection.findOne({ docId, epoch: targetEpoch });
    if (!metadata) {
        throw new Error(`Chronicle metadata not found for document ${docId} at epoch ${targetEpoch}`);
    }
    const branchId = options.branchId ?? metadata.activeBranchId;
    // Get the latest chunk to verify it's deleted
    const latestChunk = await chunksCollection.findOne({ docId, epoch: targetEpoch, branchId, isLatest: true }, { projection: { serial: 1, payload: 1, isDeleted: 1 } });
    if (!latestChunk) {
        throw new Error(`No chunks found for document ${docId} at epoch ${targetEpoch}`);
    }
    if (!latestChunk.isDeleted) {
        throw new Error(`Document ${docId} at epoch ${targetEpoch} is not deleted`);
    }
    // The deletion chunk contains the final state - use that as the restored state
    const restoredState = latestChunk.payload;
    // Validate unique constraints for the restored state
    await validateUniqueConstraints(ctx, restoredState, branchId, docId);
    // Create the document state for chunk creation
    const state = {
        docId,
        branchId,
        epoch: targetEpoch,
        currentSerial: latestChunk.serial,
        isNew: false,
        previousPayload: restoredState,
    };
    // Create a restoration chunk (FULL chunk with isDeleted: false)
    await createChronicleChunk(ctx, state, restoredState, 1, // FULL chunk
    false // isDeleted: false (restored)
    );
    // Update chronicle_keys to mark as not deleted
    await updateChronicleKeys(ctx, docId, branchId, restoredState, false);
    // Sync main collection - restore document
    const baseCollection = ctx.connection.db?.collection(ctx.baseCollectionName);
    if (baseCollection) {
        await baseCollection.updateOne({ _id: docId }, { $set: { ...restoredState, __chronicle_deleted: false } }, { upsert: true });
    }
    return {
        success: true,
        docId,
        epoch: targetEpoch,
        restoredState,
    };
}
/**
 * Lists all soft-deleted documents for this collection.
 *
 * @param ctx - Chronicle context
 * @param filters - Optional filters for the query
 * @returns Array of deleted document info
 */
async function chronicleListDeleted(ctx, filters = {}) {
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    if (!chunksCollection) {
        throw new Error('Chronicle collections not initialized');
    }
    // Build query for deleted documents using the partial index
    const query = {
        isLatest: true,
        isDeleted: true,
    };
    // Add time filters if provided
    if (filters.deletedAfter || filters.deletedBefore) {
        query.cTime = {};
        if (filters.deletedAfter) {
            query.cTime.$gt = filters.deletedAfter;
        }
        if (filters.deletedBefore) {
            query.cTime.$lt = filters.deletedBefore;
        }
    }
    // Query for all deleted chunks (using the partial index on isLatest + isDeleted)
    const deletedChunks = await chunksCollection
        .find(query)
        .sort({ cTime: -1 })
        .toArray();
    // Transform to DeletedDocInfo format
    return deletedChunks.map(chunk => ({
        docId: chunk.docId,
        epoch: chunk.epoch ?? 1,
        deletedAt: chunk.cTime,
        finalState: chunk.payload,
    }));
}
/**
 * Permanently deletes all chronicle data for a document.
 * This is an irreversible operation that removes all chunks, branches, and metadata.
 *
 * @param ctx - Chronicle context
 * @param docId - Document ID to purge
 * @param options - Purge options (must include confirm: true)
 * @returns Result containing counts of removed items
 */
async function chroniclePurge(ctx, docId, options) {
    // Safety check - require explicit confirmation
    if (options.confirm !== true) {
        throw new Error('Purge requires explicit confirmation. Set options.confirm = true to execute.');
    }
    const metadataCollectionName = ctx.options.metadataCollectionName ??
        `${ctx.baseCollectionName}_chronicle_metadata`;
    const branchCollectionName = `${ctx.baseCollectionName}_chronicle_branches`;
    const keysCollectionName = `${ctx.baseCollectionName}_chronicle_keys`;
    const metadataCollection = ctx.connection.db?.collection(metadataCollectionName);
    const branchCollection = ctx.connection.db?.collection(branchCollectionName);
    const chunksCollection = ctx.connection.db?.collection(ctx.chunksCollectionName);
    const keysCollection = ctx.connection.db?.collection(keysCollectionName);
    if (!metadataCollection || !branchCollection || !chunksCollection) {
        throw new Error('Chronicle collections not initialized');
    }
    // Build query - optionally filter by specific epoch
    const epochQuery = { docId };
    if (options.epoch !== undefined) {
        epochQuery.epoch = options.epoch;
    }
    // Get list of epochs being purged
    const metadataDocs = await metadataCollection.find(epochQuery).toArray();
    const epochsPurged = metadataDocs.map(m => m.epoch ?? 1);
    if (epochsPurged.length === 0) {
        throw new Error(`No chronicle data found for document ${docId}`);
    }
    // Delete chunks
    const chunkQuery = { docId };
    if (options.epoch !== undefined) {
        chunkQuery.epoch = options.epoch;
    }
    const chunkResult = await chunksCollection.deleteMany(chunkQuery);
    const chunksRemoved = chunkResult.deletedCount;
    // Delete branches
    const branchQuery = { docId };
    if (options.epoch !== undefined) {
        branchQuery.epoch = options.epoch;
    }
    const branchResult = await branchCollection.deleteMany(branchQuery);
    const branchesRemoved = branchResult.deletedCount;
    // Delete metadata
    await metadataCollection.deleteMany(epochQuery);
    // Delete keys entries if keys collection exists
    if (keysCollection) {
        await keysCollection.deleteMany({ docId });
    }
    return {
        success: true,
        docId,
        epochsPurged,
        chunksRemoved,
        branchesRemoved,
    };
}
//# sourceMappingURL=chronicle-operations.js.map