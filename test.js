const jsmongo = require('./jsmongo'); // Replace with actual path

async function main() {
  const db = new jsmongo({
    storageMode: 'disk',
    storagePath: './database-files',
    idleTimeout: 5 * 1000 // faster idle dump testing
  });

  await db.initialize();

  // Step 1: Login or register admin
  const adminUser = await db.loginUser('admin', 'admin');
  if (!adminUser) {
    console.error('Admin login failed');
    return;
  }
  console.log('Admin logged in');

  // Step 2: Register new user with limited permissions
  try {
    const newUser = await db.registerUser('reader', 'pass123', [
      {
        resource: 'test.one',
        permissions: ['read']
      }
    ]);
    console.log('New user registered:', newUser);
  } catch (err) {
    console.warn(err.message);
  }

  const readerUser = await db.loginUser('reader', 'pass123');

  // Step 3: Create test collection
  const t1 = db('test').collection('one');

  // Step 4: InsertOne + InsertMany
  await t1.insertOne({ name: 'Alpha' }, adminUser);
  await t1.insertMany([{ name: 'Beta' }, { name: 'Gamma' }], adminUser);

  // Step 5: Create index on 'name'
  await t1.createIndex('name', adminUser);
  console.log('Index created on "name"');

  // Step 6: Find with index
  const findIndexed = t1.find({ name: 'Alpha' }, adminUser);
  console.log('Find (indexed):', findIndexed);

  // Step 7: Find with reader (should work)
  const readerResults = t1.find({}, readerUser);
  console.log('Reader user can read:', readerResults);

  // Step 8: Try write as reader (should fail)
  const readerWrite = await t1.insertOne({ name: 'Hacker' }, readerUser);
  console.log('Reader write attempt:', readerWrite);

  // Step 9: UpdateOne (existing)
  const updateResult = await t1.updateOne(
    { name: 'Alpha' },
    { $set: { name: 'AlphaUpdated' } },
    {},
    adminUser
  );
  console.log('Update existing:', updateResult);

  // Step 10: UpdateOne with upsert
  const upsertResult = await t1.updateOne(
    { name: 'Zeta' },
    { $set: { age: 42 } },
    { upsert: true },
    adminUser
  );
  console.log('Upsert result:', upsertResult);

  // Step 11: DeleteOne
  const deleteCount = await t1.deleteOne({ name: 'Beta' }, adminUser);
  console.log('Delete count:', deleteCount);

  // Step 12: Test permission enforcement
  const canRead = db.hasPermission(readerUser, 'test.one', 'read');
  const canWrite = db.hasPermission(readerUser, 'test.one', 'write');
  console.log(`Reader can read: ${canRead}, can write: ${canWrite}`);

  // Step 13: Wait to test idle timeout (if using 'disk' mode)
  console.log('Waiting to trigger idle data dump...');
  await new Promise(resolve => setTimeout(resolve, 6000));

  // Step 14: Close DB
  await db.close();
  console.log('Database closed successfully');
}

main().catch(err => {
  console.error('Error during DB tests:', err);
});