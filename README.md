
A lightweight, MongoDB-inspired embedded JavaScript database with disk persistence, user authentication, and role-based permissions.

## Features

- In-memory or disk-based storage
- Simple MongoDB-like API for collections
- User authentication with bcrypt password hashing
- Role-based access control (read, write, admin)
- Indexing for fast queries on fields
- Idle timeout for automatic data persistence

## Installation

```sh
npm install jsmongo
```

Usage Example

See test.js for a full example. Here is a summary:

Collecting workspace informationHere is a suggested README.md for your `jsmongo` library, using test.js as an example:

```md
# jsmongo

A lightweight, MongoDB-inspired embedded JavaScript database with disk persistence, user authentication, and role-based permissions.

## Features

- In-memory or disk-based storage
- Simple MongoDB-like API for collections
- User authentication with bcrypt password hashing
- Role-based access control (read, write, admin)
- Indexing for fast queries on fields
- Idle timeout for automatic data persistence

## Installation

```sh
npm install
```

## Usage Example

See [`test.js`](test.js) for a full example. Here is a summary:

```js
const jsmongo = require('./jsmongo');

async function main() {
  const db = new jsmongo({
    storageMode: 'disk',
    storagePath: './database-files',
    idleTimeout: 5 * 1000
  });

  await db.initialize();

  // Login or register admin
  const adminUser = await db.loginUser('admin', 'admin');

  // Register a new user with read-only permissions
  await db.registerUser('reader', 'pass123', [
    { resource: 'test.one', permissions: ['read'] }
  ]);
  const readerUser = await db.loginUser('reader', 'pass123');

  // Work with a collection
  const t1 = db('test').collection('one');
  await t1.insertOne({ name: 'Alpha' }, adminUser);
  await t1.insertMany([{ name: 'Beta' }, { name: 'Gamma' }], adminUser);

  // Create index and query
  await t1.createIndex('name', adminUser);
  const results = t1.find({ name: 'Alpha' }, adminUser);

  // Permission enforcement
  const canRead = db.hasPermission(readerUser, 'test.one', 'read');
  const canWrite = db.hasPermission(readerUser, 'test.one', 'write');

  await db.close();
}

main();
```

## API

### Initialization

```js
const db = new jsmongo({
  storageMode: 'disk', // or 'memory'
  storagePath: './database-files',
  idleTimeout: 30000 // ms
});
await db.initialize();
```

### User Management

- `await db.loginUser(username, password)`
- `await db.registerUser(username, password, roles)`

### Collections

```js
const collection = db('databaseName').collection('collectionName');
```

- `await collection.insertOne(doc, user)`
- `await collection.insertMany([doc1, doc2], user)`
- `await collection.find(query, user)`
- `await collection.updateOne(filter, update, options, user)`
- `await collection.deleteOne(filter, user)`
- `await collection.createIndex(field, user)`

### Permissions

- `db.hasPermission(user, resource, permission)`

## License

MIT
```

