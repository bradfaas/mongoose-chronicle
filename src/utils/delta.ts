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
export function computeDelta(
  original: DocumentObject,
  updated: DocumentObject
): DocumentObject {
  const delta: DocumentObject = {};

  // Find changed and new fields
  for (const key of Object.keys(updated)) {
    if (key === '_id') continue; // Skip _id field

    const originalValue = original[key];
    const updatedValue = updated[key];

    if (!deepEqual(originalValue, updatedValue)) {
      delta[key] = updatedValue;
    }
  }

  // Find deleted fields (set to null in delta)
  for (const key of Object.keys(original)) {
    if (key === '_id') continue;
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
export function applyDelta(
  base: DocumentObject,
  delta: DocumentObject
): DocumentObject {
  const result = { ...base };

  for (const [key, value] of Object.entries(delta)) {
    if (value === null) {
      delete result[key];
    } else {
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
export function applyDeltas(
  base: DocumentObject,
  deltas: DocumentObject[]
): DocumentObject {
  return deltas.reduce(
    (current, delta) => applyDelta(current, delta),
    { ...base }
  );
}

/**
 * Deep equality check for two values
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (a === null || b === null) return a === b;
  if (a === undefined || b === undefined) return a === b;

  if (typeof a !== typeof b) return false;

  if (typeof a !== 'object') return a === b;

  // Handle Date objects
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  // Handle arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  // Handle objects
  if (Array.isArray(a) || Array.isArray(b)) return false;

  const objA = a as DocumentObject;
  const objB = b as DocumentObject;

  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);

  if (keysA.length !== keysB.length) return false;

  return keysA.every(key => deepEqual(objA[key], objB[key]));
}

/**
 * Checks if a delta is empty (no changes)
 */
export function isDeltaEmpty(delta: DocumentObject): boolean {
  return Object.keys(delta).length === 0;
}
