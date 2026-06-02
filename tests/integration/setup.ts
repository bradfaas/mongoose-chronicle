import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongoServer: MongoMemoryServer;

/**
 * Connect to the in-memory database before running tests
 */
export async function setupTestDatabase(): Promise<void> {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
}

/**
 * Clear all test data after each test
 */
export async function clearTestDatabase(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key]?.deleteMany({});
  }
}

/**
 * Remove and close the database connection after all tests
 */
export async function teardownTestDatabase(): Promise<void> {
  await mongoose.disconnect();
  await mongoServer.stop();
}

/**
 * Get the mongoose connection for direct database access in tests
 */
export function getConnection(): mongoose.Connection {
  return mongoose.connection;
}
