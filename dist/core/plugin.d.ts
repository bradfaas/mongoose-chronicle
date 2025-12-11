import { Schema, Connection } from 'mongoose';
import type { ChroniclePluginOptions } from '../types';
import { type SchemaIndexAnalysis } from '../utils/schema-analyzer';
/**
 * The main mongoose-chronicle plugin function
 * Transforms a standard Mongoose schema to use ChronicleChunk document storage
 */
export declare function chroniclePlugin(schema: Schema, options?: ChroniclePluginOptions): void;
/**
 * Gets the chronicle analysis for a schema
 */
export declare function getChronicleAnalysis(schema: Schema): SchemaIndexAnalysis | undefined;
/**
 * Gets the chronicle options for a schema
 */
export declare function getChronicleOptions(schema: Schema): ChroniclePluginOptions | undefined;
/**
 * Initializes chronicle collections and configuration
 * Should be called once per collection when the model is created
 */
export declare function initializeChronicle(connection: Connection, collectionName: string, options?: ChroniclePluginOptions, schemaAnalysis?: SchemaIndexAnalysis): Promise<void>;
export { ChronicleUniqueConstraintError } from './chronicle-operations';
export default chroniclePlugin;
//# sourceMappingURL=plugin.d.ts.map