import { Schema } from 'mongoose';
/**
 * Information about a field's index configuration
 */
export interface FieldIndexInfo {
    /** Field path (e.g., 'sku' or 'address.city') */
    path: string;
    /** Whether this field has an index */
    indexed: boolean;
    /** Whether this field has a unique constraint */
    unique: boolean;
    /** Whether this field is required */
    required: boolean;
    /** Whether this is a sparse index */
    sparse: boolean;
}
/**
 * Compound index definition from schema.index() calls
 */
export interface CompoundIndexInfo {
    /** Fields in the index with sort direction */
    fields: Record<string, 1 | -1>;
    /** Index options */
    options: {
        unique?: boolean;
        sparse?: boolean;
        name?: string;
    };
}
/**
 * Result of analyzing a schema for index information
 */
export interface SchemaIndexAnalysis {
    /** Fields with single-field indexes */
    indexedFields: FieldIndexInfo[];
    /** Fields with unique constraints */
    uniqueFields: FieldIndexInfo[];
    /** Compound indexes defined on the schema */
    compoundIndexes: CompoundIndexInfo[];
}
/**
 * Analyzes a Mongoose schema to extract index and unique key information
 * @param schema - The Mongoose schema to analyze
 * @returns Analysis results with indexed and unique fields
 */
export declare function analyzeSchemaIndexes(schema: Schema): SchemaIndexAnalysis;
/**
 * Creates a "clean" version of a schema with indexes and unique constraints removed
 * This is used for the payload field in ChronicleChunk
 * @param schema - The original schema
 * @returns A new schema without index/unique constraints
 */
export declare function createCleanPayloadSchema(schema: Schema): Schema;
/**
 * Generates the index definitions needed for the ChronicleChunk collection
 * @param analysis - The schema analysis result
 * @param collectionName - Name of the original collection (for naming)
 * @returns Array of index specifications to create
 */
export declare function generateChronicleIndexes(analysis: SchemaIndexAnalysis, _collectionName: string): Array<{
    spec: Record<string, 1 | -1>;
    options: Record<string, unknown>;
}>;
//# sourceMappingURL=schema-analyzer.d.ts.map