import mongoose, { Schema } from 'mongoose';
import { chroniclePlugin } from '../../src';

/**
 * Simple Hardware schema for testing - matches the example in requirements
 */
export const HardwareSchema = new Schema({
  sku: { type: String, required: true, index: true, unique: true },
  description: { type: String, index: true, default: 'unknown description' },
  price: { type: Number, default: 0 },
  category: { type: String },
});

/**
 * Hardware schema with chronicle plugin applied
 */
export const ChronicledHardwareSchema = new Schema({
  sku: { type: String, required: true, index: true, unique: true },
  description: { type: String, index: true, default: 'unknown description' },
  price: { type: Number, default: 0 },
  category: { type: String },
});

ChronicledHardwareSchema.plugin(chroniclePlugin, {
  fullChunkInterval: 5,
});

/**
 * Create models - call after database is connected
 */
export function createTestModels() {
  // Clear any existing models to avoid OverwriteModelError
  if (mongoose.models.Hardware) {
    delete mongoose.models.Hardware;
  }
  if (mongoose.models.ChronicledHardware) {
    delete mongoose.models.ChronicledHardware;
  }

  const Hardware = mongoose.model('Hardware', HardwareSchema, 'hardware');
  const ChronicledHardware = mongoose.model(
    'ChronicledHardware',
    ChronicledHardwareSchema,
    'chronicled_hardware'
  );

  return { Hardware, ChronicledHardware };
}
