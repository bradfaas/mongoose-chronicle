/**
 * Utility functions for computing and applying deltas between document states
 */
type DocumentObject = Record<string, unknown>;
/**
 * Computes the delta (difference) between two document states
 * @param original - The original document state
 * @param updated - The updated document state
 * @returns An object containing only the changed fields
 */
export declare function computeDelta(original: DocumentObject, updated: DocumentObject): DocumentObject;
/**
 * Applies a delta to a base document to produce the updated state
 * @param base - The base document state
 * @param delta - The delta to apply
 * @returns The resulting document after applying the delta
 */
export declare function applyDelta(base: DocumentObject, delta: DocumentObject): DocumentObject;
/**
 * Applies multiple deltas sequentially to a base document
 * @param base - The base document state (full chunk)
 * @param deltas - Array of deltas to apply in order
 * @returns The resulting document after applying all deltas
 */
export declare function applyDeltas(base: DocumentObject, deltas: DocumentObject[]): DocumentObject;
/**
 * Checks if a delta is empty (no changes)
 */
export declare function isDeltaEmpty(delta: DocumentObject): boolean;
export {};
//# sourceMappingURL=delta.d.ts.map