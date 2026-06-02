"use strict";
/**
 * Utility functions for computing and applying deltas between document states
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeDelta = computeDelta;
exports.applyDelta = applyDelta;
exports.applyDeltas = applyDeltas;
exports.isDeltaEmpty = isDeltaEmpty;
/**
 * Computes the delta (difference) between two document states
 * @param original - The original document state
 * @param updated - The updated document state
 * @returns An object containing only the changed fields
 */
function computeDelta(original, updated) {
    const delta = {};
    // Find changed and new fields
    for (const key of Object.keys(updated)) {
        if (key === '_id')
            continue; // Skip _id field
        const originalValue = original[key];
        const updatedValue = updated[key];
        if (!deepEqual(originalValue, updatedValue)) {
            delta[key] = updatedValue;
        }
    }
    // Find deleted fields (set to null in delta)
    for (const key of Object.keys(original)) {
        if (key === '_id')
            continue;
        if (!(key in updated)) {
            delta[key] = null;
        }
    }
    return delta;
}
/**
 * Applies a delta to a base document to produce the updated state
 * @param base - The base document state
 * @param delta - The delta to apply
 * @returns The resulting document after applying the delta
 */
function applyDelta(base, delta) {
    const result = { ...base };
    for (const [key, value] of Object.entries(delta)) {
        if (value === null) {
            delete result[key];
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
/**
 * Applies multiple deltas sequentially to a base document
 * @param base - The base document state (full chunk)
 * @param deltas - Array of deltas to apply in order
 * @returns The resulting document after applying all deltas
 */
function applyDeltas(base, deltas) {
    return deltas.reduce((current, delta) => applyDelta(current, delta), { ...base });
}
/**
 * Deep equality check for two values
 */
function deepEqual(a, b) {
    if (a === b)
        return true;
    if (a === null || b === null)
        return a === b;
    if (a === undefined || b === undefined)
        return a === b;
    if (typeof a !== typeof b)
        return false;
    if (typeof a !== 'object')
        return a === b;
    // Handle Date objects
    if (a instanceof Date && b instanceof Date) {
        return a.getTime() === b.getTime();
    }
    // Handle arrays
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length)
            return false;
        return a.every((item, index) => deepEqual(item, b[index]));
    }
    // Handle objects
    if (Array.isArray(a) || Array.isArray(b))
        return false;
    const objA = a;
    const objB = b;
    const keysA = Object.keys(objA);
    const keysB = Object.keys(objB);
    if (keysA.length !== keysB.length)
        return false;
    return keysA.every(key => deepEqual(objA[key], objB[key]));
}
/**
 * Checks if a delta is empty (no changes)
 */
function isDeltaEmpty(delta) {
    return Object.keys(delta).length === 0;
}
//# sourceMappingURL=delta.js.map